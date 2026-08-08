import {
  FIELD,
  CONES,
  YARDS_PER_METRE,
  DEFAULT_RULES,
  makeRules,
  v3,
  copy,
  distXZ,
  isInBounds,
  endzoneOf,
  isInEndzone,
  isGoal,
  goalLineZ,
  brickMark,
  clampToField,
  boundaryCrossing,
  putIntoPlaySpot,
  stallCountFor,
  stallElapsedFor,
  resumeStallCount,
  doubleTeamOffender,
  markerStatus,
  isTravel,
  effectiveTarget,
  isGameOver,
  flipDir,
  otherTeam,
  type Vec3,
  type Dir,
  type RuleSet,
  type CapState,
} from '../../src/sim/Rules.ts';

/* ----------------------------------------------------------------- rules */

/**
 * Rules primitives, sampled at every decision boundary.
 *
 * These are almost entirely pure arithmetic — compare, add, multiply, sqrt,
 * floor — so the Swift port is asserted BIT-EXACT. The whole point of this
 * fixture set is boundary coverage: a `<=` in the reference written as `<` in
 * the port, or a `G_EPS`/`T_EPS` slack applied on the wrong side, only shows up
 * when a case sits exactly on the line. Every boundary below is sampled from
 * both sides.
 */
export function rulesGoldens() {
  const p = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

  const rulesVariant = (over: Partial<RuleSet>) => makeRules(over);

  /* -------------------------------------------------------------- distXZ */
  const distXZCases = [
    { a: p(0, 0, 0), b: p(0, 0, 0) },
    { a: p(3, 0, 4), b: p(0, 0, 0) }, // classic 3-4-5
    { a: p(-3, 5, -4), b: p(0, 9, 0) }, // y must be ignored
    { a: p(1.5, 0, -2.25), b: p(-9.75, 3, 8.125) },
    { a: p(-18.5, 0, -50), b: p(18.5, 0, 50) }, // corner to corner
  ].map(({ a, b }) => ({ a, b, want: distXZ(a, b) }));

  /* ---------------------------------------------------------- isInBounds */
  const G_EPS = 1e-9;
  const isInBoundsCases = [
    p(0, 0, 0),
    p(FIELD.SIDELINE, 0, 0), // exactly on the sideline: in
    p(FIELD.SIDELINE + G_EPS / 2, 0, 0), // inside the epsilon slack: in
    p(FIELD.SIDELINE + 1e-6, 0, 0), // outside the slack: out
    p(-FIELD.SIDELINE, 0, 0),
    p(-FIELD.SIDELINE - 1e-6, 0, 0),
    p(0, 0, FIELD.END_LINE),
    p(0, 0, FIELD.END_LINE + 1e-6),
    p(0, 0, -FIELD.END_LINE),
    p(0, 0, -FIELD.END_LINE - 1e-6),
    p(FIELD.SIDELINE, 0, FIELD.END_LINE), // corner, exactly in
    p(FIELD.SIDELINE + 1e-6, 0, FIELD.END_LINE + 1e-6), // corner, just out
  ].map((pt) => ({ p: pt, want: isInBounds(pt) }));

  /* ---------------------------------------------------------- endzoneOf */
  const endzoneOfCases = [
    0,
    FIELD.GOAL_LINE,
    FIELD.GOAL_LINE - G_EPS / 2, // inside the slack: still endzone
    FIELD.GOAL_LINE - 1e-6, // outside the slack: not yet
    FIELD.GOAL_LINE + 5,
    -FIELD.GOAL_LINE,
    -FIELD.GOAL_LINE + G_EPS / 2,
    -FIELD.GOAL_LINE + 1e-6,
    -FIELD.GOAL_LINE - 5,
  ].map((z) => ({ z, want: endzoneOf(z) }));

  /* -------------------------------------------------------- isInEndzone */
  const isInEndzoneCases: { p: Vec3; dir: Dir; want: boolean }[] = [];
  for (const dir of [1, -1] as Dir[]) {
    for (const z of [
      dir * FIELD.GOAL_LINE,
      dir * (FIELD.GOAL_LINE - 1e-6),
      dir * (FIELD.GOAL_LINE + 5),
      0,
    ]) {
      for (const x of [0, FIELD.SIDELINE, FIELD.SIDELINE + 1e-6]) {
        const pt = p(x, 0, z);
        isInEndzoneCases.push({ p: pt, dir, want: isInEndzone(pt, dir) });
      }
    }
  }

  /* --------------------------------------------------------------- isGoal */
  // isGoal is a pure alias of isInEndzone; a small subset is enough to prove
  // the alias, not to re-derive the boundary sweep above.
  const isGoalCases = [
    { p: p(0, 0, FIELD.GOAL_LINE), dir: 1 as Dir },
    { p: p(0, 0, FIELD.GOAL_LINE - 1e-6), dir: 1 as Dir },
    { p: p(0, 0, -FIELD.GOAL_LINE), dir: -1 as Dir },
    { p: p(FIELD.SIDELINE + 1, 0, FIELD.END_LINE), dir: 1 as Dir },
  ].map(({ p: pt, dir }) => ({ p: pt, dir, want: isGoal(pt, dir) }));

  /* ------------------------------------------------------------ goalLineZ */
  const goalLineZCases = ([1, -1] as Dir[]).map((dir) => ({ dir, want: goalLineZ(dir) }));

  /* ------------------------------------------------------------ brickMark */
  const brickMarkCases = ([1, -1] as Dir[]).map((dir) => ({ dir, want: brickMark(dir) }));

  /* --------------------------------------------------------- clampToField */
  const clampToFieldCases = [
    p(0, 0, 0),
    p(FIELD.SIDELINE, 5, FIELD.END_LINE), // already on the boundary
    p(FIELD.SIDELINE + 10, 5, FIELD.END_LINE + 10), // beyond both
    p(-FIELD.SIDELINE - 10, 5, -FIELD.END_LINE - 10),
    p(3, 5, -70), // only z out
  ].map((pt) => ({ p: pt, want: clampToField(pt) }));

  /* ------------------------------------------------------ boundaryCrossing */
  const boundaryCrossingCases = [
    { a: p(0, 0, 0), b: p(1, 0, 1) }, // wholly inside: null
    { a: p(0, 0, 0), b: p(30, 0, 0) }, // exits +x sideline
    { a: p(0, 0, 0), b: p(-30, 0, 0) }, // exits -x sideline
    { a: p(0, 0, 0), b: p(0, 0, 60) }, // exits +z end line
    { a: p(0, 0, 0), b: p(0, 0, -60) }, // exits -z end line
    { a: p(0, 0, 0), b: p(30, 0, 60) }, // exits the corner: sideline wins the tie
    { a: p(20, 0, 0), b: p(20, 0, 1) }, // starts already outside, moving parallel
    { a: p(0, 0, 0), b: p(0, 0, 0) }, // degenerate zero-length segment: null
    { a: p(-30, 0, 0), b: p(30, 0, 0) }, // crosses clean through, both ends out
  ].map(({ a, b }) => ({ a, b, want: boundaryCrossing(a, b) }));

  /* ---------------------------------------------------- putIntoPlaySpot */
  const putIntoPlaySpotCases: {
    spot: Vec3;
    attackDir: Dir;
    rules: RuleSet;
    want: Vec3;
  }[] = [];
  for (const attackDir of [1, -1] as Dir[]) {
    const zones: [string, number][] = [
      ['attacking-endzone', attackDir * (FIELD.GOAL_LINE + 5)],
      ['attacking-endzone-boundary', attackDir * FIELD.GOAL_LINE],
      ['attacking-endzone-boundary-below', attackDir * (FIELD.GOAL_LINE - 1e-6)],
      ['defending-endzone', -attackDir * (FIELD.GOAL_LINE + 5)],
      ['defending-endzone-boundary', -attackDir * FIELD.GOAL_LINE],
      ['defending-endzone-boundary-below', -attackDir * (FIELD.GOAL_LINE - 1e-6)],
      ['midfield', 0],
    ];
    for (const [, z] of zones) {
      const spot = p(5, 0, z);
      for (const rules of [
        DEFAULT_RULES,
        rulesVariant({ walkToGoalLineFromAttackingEndzone: false }),
        rulesVariant({ walkOutOfDefendingEndzone: false }),
        rulesVariant({ walkToGoalLineFromAttackingEndzone: false, walkOutOfDefendingEndzone: false }),
      ]) {
        putIntoPlaySpotCases.push({ spot, attackDir, rules, want: putIntoPlaySpot(spot, attackDir, rules) });
      }
    }
    // A spot beyond the sidelines, so clamp-then-walk order is exercised.
    const wideSpot = p(FIELD.SIDELINE + 20, 0, attackDir * (FIELD.GOAL_LINE + 5));
    putIntoPlaySpotCases.push({
      spot: wideSpot,
      attackDir,
      rules: DEFAULT_RULES,
      want: putIntoPlaySpot(wideSpot, attackDir, DEFAULT_RULES),
    });
  }

  /* ------------------------------------------------------------ stallCountFor */
  const stallCountForCases: { elapsed: number; rules: RuleSet; want: number }[] = [];
  for (const rules of [DEFAULT_RULES, rulesVariant({ stallInterval: 1.5, stallMax: 7 })]) {
    for (const n of [0, 1, 5, rules.stallMax]) {
      const exact = n * rules.stallInterval;
      stallCountForCases.push(
        { elapsed: exact - 1e-7, rules }, // just below the tick
        { elapsed: exact, rules }, // exactly on the tick
        { elapsed: exact + 1e-7, rules }, // just above the tick
      );
    }
    stallCountForCases.push(
      { elapsed: -5, rules }, // negative: clamps to 0
      { elapsed: 0, rules },
      { elapsed: (rules.stallMax + 3) * rules.stallInterval, rules }, // past the cap
    );
  }
  const stallCountForOut = stallCountForCases.map((c) => ({ ...c, want: stallCountFor(c.elapsed, c.rules) }));

  /* ---------------------------------------------------------- stallElapsedFor */
  const stallElapsedForCases: { count: number; rules: RuleSet }[] = [];
  for (const rules of [DEFAULT_RULES, rulesVariant({ stallInterval: 1.5 })]) {
    for (const count of [-3, 0, 1, rules.stallMax, rules.stallMax + 2]) {
      stallElapsedForCases.push({ count, rules });
    }
  }
  const stallElapsedForOut = stallElapsedForCases.map((c) => ({
    ...c,
    want: stallElapsedFor(c.count, c.rules),
  }));

  /* --------------------------------------------------------- resumeStallCount */
  const resumeStallCountCases: { count: number; rules: RuleSet }[] = [];
  for (const rules of [DEFAULT_RULES, rulesVariant({ stallResumeCap: 4 })]) {
    for (const count of [-2, 0, rules.stallResumeCap - 1, rules.stallResumeCap, rules.stallResumeCap + 3]) {
      resumeStallCountCases.push({ count, rules });
    }
  }
  const resumeStallCountOut = resumeStallCountCases.map((c) => ({
    ...c,
    want: resumeStallCount(c.count, c.rules),
  }));

  /* -------------------------------------------------------- doubleTeamOffender */
  type Actor = { id: number; pos: Vec3 };
  const dtRules = DEFAULT_RULES;
  const r = dtRules.doubleTeamRange;
  const pivot = p(0, 0, 0);

  const dtCases: {
    label: string;
    pivot: Vec3;
    markerId: number | null;
    defenders: Actor[];
    offence: Actor[];
    throwerId: number | null;
    rules: RuleSet;
  }[] = [
    {
      label: 'no defenders nearby',
      pivot,
      markerId: 1,
      defenders: [{ id: 1, pos: p(1, 0, 0) }, { id: 2, pos: p(100, 0, 0) }],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'marker himself is excluded even inside range',
      pivot,
      markerId: 1,
      defenders: [{ id: 1, pos: p(0.1, 0, 0) }],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'second defender guarding a cutter is excused',
      pivot,
      markerId: 1,
      defenders: [
        { id: 1, pos: p(0.1, 0, 0) }, // marker
        { id: 2, pos: p(2, 0, 0) }, // inside r, but guarding id 11
      ],
      offence: [
        { id: 10, pos: p(0, 0, 0) }, // thrower, excluded from the "guarding" check
        { id: 11, pos: p(2, 0, 0.05) }, // within r of defender 2
      ],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'second defender near only the thrower is a double team',
      pivot,
      markerId: 1,
      defenders: [
        { id: 1, pos: p(0.1, 0, 0) },
        { id: 2, pos: p(2, 0, 0) },
      ],
      offence: [{ id: 10, pos: p(0, 0, 0) }], // thrower excluded, so nothing excuses defender 2
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'exactly at the range boundary counts as within range',
      pivot,
      markerId: 1,
      defenders: [{ id: 2, pos: p(r, 0, 0) }],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'just outside the range boundary does not count',
      pivot,
      markerId: 1,
      defenders: [{ id: 2, pos: p(r + 1e-6, 0, 0) }],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'excuse distance exactly at boundary counts as excused',
      pivot,
      markerId: 1,
      defenders: [{ id: 2, pos: p(2, 0, 0) }],
      offence: [
        { id: 10, pos: p(0, 0, 0) },
        { id: 11, pos: p(2 + r, 0, 0) }, // exactly r from defender 2
      ],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'excuse distance just past boundary does not excuse',
      pivot,
      markerId: 1,
      defenders: [{ id: 2, pos: p(2, 0, 0) }],
      offence: [
        { id: 10, pos: p(0, 0, 0) },
        { id: 11, pos: p(2 + r + 1e-6, 0, 0) },
      ],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'first offending defender in list order wins',
      pivot,
      markerId: null,
      defenders: [
        { id: 3, pos: p(0.2, 0, 0) },
        { id: 4, pos: p(0.3, 0, 0) },
      ],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: 10,
      rules: dtRules,
    },
    {
      label: 'no marker at all, defender still evaluated',
      pivot,
      markerId: null,
      defenders: [{ id: 5, pos: p(0.1, 0, 0) }],
      offence: [{ id: 10, pos: p(0, 0, 0) }],
      throwerId: null,
      rules: dtRules,
    },
  ];
  const doubleTeamOffenderOut = dtCases.map((c) => ({
    ...c,
    want: doubleTeamOffender(c.pivot, c.markerId, c.defenders, c.offence, c.throwerId, c.rules),
  }));

  /* ------------------------------------------------------------- markerStatus */
  const msRules = DEFAULT_RULES;
  const thrower = p(0, 0, 0);
  const markerStatusCases: { markerPos: Vec3 | null; throwerPos: Vec3; rules: RuleSet }[] = [
    { markerPos: null, throwerPos: thrower, rules: msRules },
    { markerPos: p(msRules.markerRange, 0, 0), throwerPos: thrower, rules: msRules }, // exactly at range: legal
    { markerPos: p(msRules.markerRange + 1e-6, 0, 0), throwerPos: thrower, rules: msRules }, // just past: out of range
    { markerPos: p(msRules.discSpace, 0, 0), throwerPos: thrower, rules: msRules }, // exactly at disc space: legal
    { markerPos: p(msRules.discSpace - 1e-6, 0, 0), throwerPos: thrower, rules: msRules }, // just inside: disc space foul
    { markerPos: p(1.5, 0, 0), throwerPos: thrower, rules: msRules }, // comfortably legal
  ];
  const markerStatusOut = markerStatusCases.map((c) => ({
    ...c,
    want: markerStatus(c.markerPos, c.throwerPos, c.rules),
  }));

  /* ---------------------------------------------------------------- isTravel */
  const itRules = DEFAULT_RULES;
  const isTravelCases = [
    { pivot: p(0, 0, 0), foot: p(itRules.travelTolerance, 0, 0) }, // exactly at tolerance: not a travel
    { pivot: p(0, 0, 0), foot: p(itRules.travelTolerance + 1e-6, 0, 0) }, // just past: travel
    { pivot: p(0, 0, 0), foot: p(0, 0, 0) }, // no movement
    { pivot: p(1, 0, 1), foot: p(1, 5, 1) }, // y-only movement is invisible to isTravel
  ].map((c) => ({ ...c, rules: itRules, want: isTravel(c.pivot, c.foot, itRules) }));

  /* ----------------------------------------------------------- effectiveTarget */
  const effectiveTargetCases: { score: [number, number]; rules: RuleSet; cap: CapState }[] = [];
  const etRules = DEFAULT_RULES;
  const etRulesLowCap = rulesVariant({ pointCap: 12 });
  for (const rules of [etRules, etRulesLowCap]) {
    for (const cap of ['none', 'soft', 'hard'] as CapState[]) {
      for (const score of [
        [0, 0],
        [5, 3],
        [3, 5],
        [11, 9],
        [11, 11],
      ] as [number, number][]) {
        effectiveTargetCases.push({ score, rules, cap });
      }
    }
  }
  const effectiveTargetOut = effectiveTargetCases.map((c) => ({
    ...c,
    want: effectiveTarget(c.score, c.rules, c.cap),
  }));

  /* -------------------------------------------------------------- isGameOver */
  const igoRules = DEFAULT_RULES;
  const isGameOverCases: { score: [number, number]; target: number; rules: RuleSet; cap: CapState }[] = [
    { score: [15, 10], target: 15, rules: igoRules, cap: 'none' }, // reached gameTo, winBy 1: over
    { score: [14, 10], target: 15, rules: igoRules, cap: 'none' }, // not yet
    { score: [17, 15], target: 15, rules: igoRules, cap: 'none' }, // hard point cap ceiling regardless of target
    { score: [16, 15], target: 15, rules: igoRules, cap: 'none' }, // below the cap, margin 1, target already met
    { score: [16, 16], target: 17, rules: igoRules, cap: 'none' }, // tied at cap-1, not over
    { score: [9, 8], target: 9, rules: igoRules, cap: 'hard' }, // hard cap: any margin >=1 at/above target ends it
    { score: [8, 8], target: 9, rules: igoRules, cap: 'hard' },
    { score: [9, 7], target: 9, rules: rulesVariant({ winBy: 2 }), cap: 'none' }, // winBy 2, margin 2: over
    { score: [9, 8], target: 9, rules: rulesVariant({ winBy: 2 }), cap: 'none' }, // winBy 2, margin 1: not over
  ];
  const isGameOverOut = isGameOverCases.map((c) => ({
    ...c,
    want: isGameOver(c.score, c.target, c.rules, c.cap),
  }));

  /* ------------------------------------------------------------------ flipDir */
  const flipDirCases = ([1, -1] as Dir[]).map((d) => ({ d, want: flipDir(d) }));

  /* ----------------------------------------------------------------- otherTeam */
  const otherTeamCases = ([0, 1] as const).map((t) => ({ t, want: otherTeam(t) }));

  /* --------------------------------------------------------------- v3 / copy */
  const v3Cases = [
    { args: [] as number[], want: v3() },
    { args: [1, 2, 3], want: v3(1, 2, 3) },
    { args: [-4.5], want: v3(-4.5) },
  ];
  const original = p(1, 2, 3);
  const copyCase = { input: original, want: copy(original) };

  return {
    note:
      'Generated by tools/gen-goldens.ts from src/sim/Rules.ts. Every function here is ' +
      'pure arithmetic — compare/add/multiply/divide/sqrt/floor — so the Swift port ' +
      'must match BIT-EXACT. Cases are drawn from both sides of every boundary.',

    field: FIELD,
    cones: CONES,
    yardsPerMetre: YARDS_PER_METRE,
    defaultRules: DEFAULT_RULES,
    makeRulesOverride: {
      over: { stallMax: 6, gameTo: 21 },
      want: makeRules({ stallMax: 6, gameTo: 21 }),
    },
    makeRulesNoOverride: makeRules(),

    v3Cases,
    copyCase,

    distXZCases,
    isInBoundsCases,
    endzoneOfCases,
    isInEndzoneCases,
    isGoalCases,
    goalLineZCases,
    brickMarkCases,
    clampToFieldCases,
    boundaryCrossingCases,
    putIntoPlaySpotCases,

    stallCountForCases: stallCountForOut,
    stallElapsedForCases: stallElapsedForOut,
    resumeStallCountCases: resumeStallCountOut,
    doubleTeamOffenderCases: doubleTeamOffenderOut,
    markerStatusCases: markerStatusOut,
    isTravelCases,

    effectiveTargetCases: effectiveTargetOut,
    isGameOverCases: isGameOverOut,
    flipDirCases,
    otherTeamCases,
  };
}
