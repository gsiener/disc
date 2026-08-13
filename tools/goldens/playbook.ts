import {
  FIELD,
  PLAY,
  FORCE_DEADBAND,
  POSITIONAL_FORCES,
  ALL_LANES,
  clamp,
  lerp,
  smoothstep,
  dist2,
  distSq2,
  sigmoid,
  clampToField,
  inBounds,
  yardsToGoal,
  inAttackEndzone,
  inOwnEndzone,
  handSideSign,
  openSideSign,
  openSideFor,
  breakSideFor,
  breakSideSign,
  releaseSideType,
  stackColumnX,
  formationStations,
  handlerCount,
  hasColumn,
  chooseFormation,
  laneOf,
  buildCut,
  markPoint,
  zoneStations,
  shouldPlayZone,
  drawWeather,
  timeoutIntent,
  SeededRng,
  WEATHER,
  TIMEOUT_PLAY,
  type TimeoutRead,
  type Vec2,
  type Sign,
  type AttackDir,
  type Force,
  type FormationName,
  type CutKind,
  type Handedness,
} from '../../src/sim/Playbook.ts';

/* -------------------------------------------------------------- playbook */

/**
 * Playbook geometry, sampled at every decision boundary.
 *
 * Almost all of this is `+ - * / min max abs clamp` on doubles, which IEEE 754
 * makes correctly rounded — so the Swift port is asserted BIT-EXACT. The three
 * exceptions are called out in the consuming suite: `dist2` and `markPoint` go
 * through `Math.hypot`, and `sigmoid` through `Math.exp`, neither of which any
 * libm pins to the last ulp.
 *
 * The point of the sampling below is boundary coverage. A `<` written as `<=`,
 * a sign transposed, or a clamp applied to the wrong end only shows up when a
 * case sits exactly on the line, so every threshold is sampled from both sides
 * and exactly on it:
 *
 *   - `FORCE_DEADBAND` at 3.0, from |discX| = 2.999 / 3 / 3.001
 *   - `laneOf`'s downfield cuts at 1.5 and 16, and its side test at exactly 0
 *   - `chooseFormation`'s 13 m, 14.0 m and 7.5 m/s triggers
 *   - every `clamp` in `clampToField`, `stackColumnX`, `dump`/`swing` and the
 *     endzone row, from inside, exactly on, and outside
 *   - `smoothstep`'s degenerate `edge0 === edge1` span, which JavaScript's `||`
 *     rewrites to 1e-6
 *
 * The field is the regulation one throughout, because that is the only pitch
 * `Playbook.ts` can express — it reads a module-level `FIELD`. The Swift port
 * threads the pitch as a value, so the suite runs these against
 * `Playbook.regulation` and asserts the minis pitch separately, by property.
 */
export function playbookGoldens() {
  const v = (x: number, z: number): Vec2 => ({ x, z });

  const DIRS: AttackDir[] = [1, -1];
  const SIGNS: Sign[] = [1, -1];
  const FORCES: Force[] = ['forehand', 'backhand', 'straight', 'middle', 'sideline'];
  const FORMATIONS: FormationName[] = ['vertical', 'horizontal', 'side', 'endzone'];
  const KINDS: CutKind[] = [
    'under', 'break-under', 'deep', 'strike', 'up-line', 'dump', 'swing',
  ];
  const HANDS: Handedness[] = ['right', 'left'];

  /* ----------------------------------------------------------- constants */
  const constants = {
    FIELD: {
      halfWidth: FIELD.halfWidth,
      halfLength: FIELD.halfLength,
      goalLine: FIELD.goalLine,
      endzoneDepth: FIELD.endzoneDepth,
      brick: FIELD.brick,
      edgeMargin: FIELD.edgeMargin,
    },
    PLAY: { ...PLAY },
    FORCE_DEADBAND,
    POSITIONAL_FORCES: [...POSITIONAL_FORCES],
    ALL_LANES: [...ALL_LANES],
  };

  /* --------------------------------------------------------------- maths */
  const clampCases = [
    [0, -1, 1], [-2, -1, 1], [2, -1, 1], [-1, -1, 1], [1, -1, 1],
    [-1.0000000000000002, -1, 1], [0.9999999999999999, -1, 1],
    // lo > hi: the reference's chained ternary returns hi. Pinned so the port
    // cannot "fix" it into returning lo.
    [0, 5, -5],
    [0.3, 0, 0], [-0, -1, 1],
  ].map(([x, lo, hi]) => ({ v: x, lo, hi, want: clamp(x, lo, hi) }));

  const lerpCases = [
    [0, 1, 0], [0, 1, 1], [0, 1, 0.5], [0, 1, -0.5], [0, 1, 1.5],
    [-3.25, 7.75, 0.3], [5, 5, 0.7], [1e8, 1e-8, 0.25],
  ].map(([a, b, t]) => ({ a, b, t, want: lerp(a, b, t) }));

  const smoothstepCases = [
    // Below, on, inside, on, above.
    [0, 1, -1], [0, 1, 0], [0, 1, 0.25], [0, 1, 0.5], [0, 1, 0.75], [0, 1, 1], [0, 1, 2],
    // Reversed edges: the span is negative, so the ramp runs the other way.
    [1, 0, 0.25], [1, 0, 0.75],
    // Degenerate span. `(edge1 - edge0) || 1e-6` makes this a near-step.
    [4, 4, 3.9999995], [4, 4, 4], [4, 4, 4.0000005], [4, 4, 5],
    // The pair `shouldPlayZone` actually uses.
    [4.5, 11, 0], [4.5, 11, 4.5], [4.5, 11, 7.75], [4.5, 11, 11], [4.5, 11, 20],
  ].map(([e0, e1, x]) => ({ edge0: e0, edge1: e1, x, want: smoothstep(e0, e1, x) }));

  const dist2Cases = [
    [0, 0, 0, 0], [3, 0, 0, 4], [-3, -4, 0, 0], [1.5, -2.25, -9.75, 8.125],
    [-18.5, -50, 18.5, 50], [0.1, 0.2, 0.1, 0.2],
  ].map(([ax, az, bx, bz]) => ({
    ax, az, bx, bz, dist: dist2(ax, az, bx, bz), distSq: distSq2(ax, az, bx, bz),
  }));

  const sigmoidCases = [
    [0, 1], [1, 1], [-1, 1], [3, 2], [-3, 2], [0.5, 0], [10, 1], [-10, 1],
  ].map(([x, k]) => ({ x, k, want: sigmoid(x, k) }));

  /* ------------------------------------------------------ field geometry */
  const M = FIELD.edgeMargin;
  const clampToFieldCases: Array<{ p: Vec2; margin: number | null; want: Vec2 }> = [];
  for (const margin of [null, 0, M, 2.5, 25]) {
    const mm = margin === null ? M : margin;
    for (const p of [
      v(0, 0),
      v(FIELD.halfWidth - mm, 0), // exactly on the x clamp
      v(FIELD.halfWidth - mm + 1e-9, 0),
      v(FIELD.halfWidth - mm - 1e-9, 0),
      v(-FIELD.halfWidth + mm, 0),
      v(-FIELD.halfWidth + mm - 1e-9, 0),
      v(0, FIELD.halfLength - mm),
      v(0, FIELD.halfLength - mm + 1e-9),
      v(0, -FIELD.halfLength + mm),
      v(0, -FIELD.halfLength + mm - 1e-9),
      v(100, -100),
      v(-100, 100),
    ]) {
      clampToFieldCases.push({
        p, margin,
        want: margin === null ? clampToField(p) : clampToField(p, margin),
      });
    }
  }

  const inBoundsCases: Array<{ x: number; z: number; margin: number; want: boolean }> = [];
  for (const margin of [0, 0.9, 5]) {
    for (const [x, z] of [
      [0, 0],
      [FIELD.halfWidth - margin, 0], [FIELD.halfWidth - margin + 1e-9, 0],
      [-(FIELD.halfWidth - margin), 0], [-(FIELD.halfWidth - margin) - 1e-9, 0],
      [0, FIELD.halfLength - margin], [0, FIELD.halfLength - margin + 1e-9],
      [0, -(FIELD.halfLength - margin)], [0, -(FIELD.halfLength - margin) - 1e-9],
      [30, 60],
    ]) {
      inBoundsCases.push({ x, z, margin, want: inBounds(x, z, margin) });
    }
  }

  const goalCases: Array<{
    z: number; dir: AttackDir; yards: number; attack: boolean; own: boolean;
  }> = [];
  for (const dir of DIRS) {
    for (const z of [
      0, 14, -14, FIELD.goalLine, -FIELD.goalLine,
      FIELD.goalLine - 1e-9, FIELD.goalLine + 1e-9,
      -FIELD.goalLine + 1e-9, -FIELD.goalLine - 1e-9,
      FIELD.halfLength, -FIELD.halfLength, 13, -13,
    ]) {
      goalCases.push({
        z, dir,
        yards: yardsToGoal(z, dir),
        attack: inAttackEndzone(z, dir),
        own: inOwnEndzone(z, dir),
      });
    }
  }

  /* -------------------------------------------------------- force / side */
  const handSideSignCases = HANDS.flatMap((handed) =>
    DIRS.map((dir) => ({ handed, dir, want: handSideSign(handed, dir) })));

  const openSideSignCases = FORCES.flatMap((force) =>
    DIRS.map((dir) => ({
      force, dir,
      open: openSideSign(force, dir),
      brk: breakSideSign(force, dir),
    })));

  const DEADBAND_XS = [
    0, 1.5, -1.5,
    FORCE_DEADBAND - 1e-9, FORCE_DEADBAND, FORCE_DEADBAND + 1e-9,
    -(FORCE_DEADBAND - 1e-9), -FORCE_DEADBAND, -(FORCE_DEADBAND - 0) - 1e-9,
    9.4, -9.4, 18.5, -18.5,
  ];
  const openSideForCases: Array<{
    force: Force; dir: AttackDir; discX: number; prev: Sign | null;
    open: Sign; brk: Sign;
  }> = [];
  for (const force of FORCES) {
    for (const dir of DIRS) {
      for (const discX of DEADBAND_XS) {
        for (const prev of [null, 1, -1] as Array<Sign | null>) {
          openSideForCases.push({
            force, dir, discX, prev,
            open: openSideFor(force, dir, discX, prev),
            brk: breakSideFor(force, dir, discX, prev),
          });
        }
      }
    }
  }

  const releaseSideTypeCases = HANDS.flatMap((handed) =>
    DIRS.flatMap((dir) =>
      // Zero and negative zero both fall through JavaScript's `||` to the
      // forehand side; the port has to reproduce that, not just handle +0.
      [0, -0, 1, -1, 0.001, -0.001, 12.5, -12.5].map((releaseSignX) => ({
        handed, dir, releaseSignX, want: releaseSideType(handed, dir, releaseSignX),
      }))));

  /* ---------------------------------------------------------- formations */
  const stackColumnXCases = FORMATIONS.flatMap((name) =>
    SIGNS.flatMap((openSign) =>
      // The clamp on `a.x * 0.3` bites at |a.x| = 16.666…; sample either side.
      [0, 5, -5, 16.6, 16.666666666666668, 16.7, 18.5, -18.5, 50, -50].map((ax) => ({
        name, openSign, a: v(ax, 0), want: stackColumnX(name, v(ax, 0), openSign),
      }))));

  const DISCS: Vec2[] = [
    v(0, 0),
    v(0, 20),
    v(12.5, -8),
    v(-12.5, 8),
    v(17.4, 0), // the wide disc the row-slide comment is written about
    v(-17.6, 3),
    v(0, -30), // pinned on its own goal line
    v(0, 30), // deep in the attacking half
    v(3.5, 31.9),
    v(-9, -44),
  ];

  const formationStationsCases = FORMATIONS.flatMap((name) =>
    DIRS.flatMap((dir) =>
      SIGNS.flatMap((openSign) =>
        DISCS.map((a) => ({
          name, a, dir, openSign, want: formationStations(name, a, dir, openSign),
        })))));

  const handlerCountCases = FORMATIONS.map((name) => ({
    name, handlers: handlerCount(name), column: hasColumn(name),
  }));

  const chooseFormationCases: Array<{
    disc: Vec2; dir: AttackDir; prefer: FormationName; windSpeed: number;
    openSign: Sign; foeZone: boolean; want: FormationName;
  }> = [];
  for (const dir of DIRS) {
    for (const openSign of SIGNS) {
      for (const prefer of FORMATIONS) {
        for (const windSpeed of [0, 7.5, 7.500000000000001, 12]) {
          // foeZone only matters once windSpeed clears the 7.5 threshold
          // (#57's fix), but it is swept unconditionally so a regression
          // that made it leak into the untriggered branches would show up.
          for (const foeZone of [false, true]) {
            for (const disc of [
              v(0, 0),
              v(0, dir * 19), // yardsToGoal = 13 exactly
              v(0, dir * 19.000000000000004),
              v(0, dir * 18.9),
              v(14.0, 0), // exactly on the |x| > 14 trigger: not side
              v(14.000000000000002, 0),
              v(-14.000000000000002, 0),
              v(17.9, -4),
              v(-17.9, -4),
            ]) {
              chooseFormationCases.push({
                disc, dir, prefer, windSpeed, openSign, foeZone,
                want: chooseFormation(disc, dir, prefer, windSpeed, openSign, foeZone),
              });
            }
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- cuts */
  const laneOfCases: Array<{
    x: number; z: number; disc: Vec2; dir: AttackDir; openSign: Sign; want: string;
  }> = [];
  for (const dir of DIRS) {
    for (const openSign of SIGNS) {
      const disc = v(2, -5);
      for (const dz of [
        -10, 0, 1.4999999999999998, 1.5, 1.5000000000000002,
        8, 15.999999999999998, 16, 16.000000000000004, 30,
      ]) {
        for (const dx of [-8, -1e-9, 0, 1e-9, 8]) {
          const x = disc.x + dx;
          const z = disc.z + dir * dz;
          laneOfCases.push({
            x, z, disc, dir, openSign, want: laneOf(x, z, disc, dir, openSign),
          });
        }
      }
    }
  }

  const buildCutCases: Array<{
    kind: CutKind; from: Vec2; disc: Vec2; dir: AttackDir; openSign: Sign;
    side: Sign; j: number; want: ReturnType<typeof buildCut>;
  }> = [];
  for (const kind of KINDS) {
    for (const dir of DIRS) {
      for (const openSign of SIGNS) {
        for (const side of SIGNS) {
          for (const j of [0, 0.5, 1]) {
            for (const [from, disc] of [
              [v(0, 12), v(0, 0)],
              [v(-6, 26), v(3.5, 2)],
              [v(16, 5), v(17.4, 1)],
              // Pinned on its own goal line: the dump/swing floor engages, and
              // the width compensation with it.
              [v(1, -28), v(0, -30)],
              [v(-2, -33), v(-1, -31.5)],
              // Deep enough that the `deep` reach hits its 38 m ceiling.
              [v(0, 28), v(0, 0)],
            ] as Array<[Vec2, Vec2]>) {
              buildCutCases.push({
                kind, from, disc, dir, openSign, side, j,
                want: buildCut(kind, from, disc, dir, openSign, side, j),
              });
            }
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- mark */
  const markPointCases = DIRS.flatMap((dir) =>
    SIGNS.flatMap((breakSign) =>
      [undefined, 0, PLAY.markDistance, PLAY.markMax, 5].map((distance) => ({
        thrower: v(3.5, -7.25), dir, breakSign,
        distance: distance === undefined ? null : distance,
        want: distance === undefined
          ? markPoint(v(3.5, -7.25), dir, breakSign)
          : markPoint(v(3.5, -7.25), dir, breakSign, distance),
      }))));

  /* ---------------------------------------------------------------- zone */
  const zoneStationsCases = DIRS.flatMap((dir) =>
    SIGNS.flatMap((openSign) =>
      [v(0, 0), v(12, -10), v(-15, 20), v(0, 28), v(4, 31)].flatMap((disc) =>
        // null, inside the +/-9 clamp, and outside it on both sides.
        [null, v(0, 0), v(16.36, 30), v(-16.36, 30), v(-18.5, 0)].map((deepThreat) => ({
          disc, dir, openSign, deepThreat,
          want: zoneStations(disc, dir, openSign, deepThreat),
        })))));

  const shouldPlayZoneCases: Array<{
    windSpeed: number; scoreDiff: number; pointsPlayed: number; bias: number;
    want: boolean;
  }> = [];
  for (const windSpeed of [0, 4.5, 7, 7.75, 11, 20]) {
    for (const scoreDiff of [0, 2, 3, 4, -5]) {
      for (const pointsPlayed of [0, 6, 7, 20]) {
        for (const bias of [0, 0.15, 0.5, -0.4]) {
          shouldPlayZoneCases.push({
            windSpeed, scoreDiff, pointsPlayed, bias,
            want: shouldPlayZone(windSpeed, scoreDiff, pointsPlayed, bias),
          });
        }
      }
    }
  }

  // The weather draw, over enough seeds that both modes are represented. Three
  // draws deep, so a port that reorders them fails on the first windy seed.
  const weatherCases: Array<{
    seed: number; wind: Vec2; speed: number; windy: boolean;
  }> = [];
  for (let seed = 1; seed <= 64; seed++) {
    const w = drawWeather(new SeededRng(seed >>> 0));
    weatherCases.push({ seed, wind: w.wind, speed: w.speed, windy: w.windy });
  }

  const timeoutCases: Array<TimeoutRead & { want: string }> = [];
  for (const stall of [0, 1, 2, 2.5, 6.9, 7, 8, 9.5]) {
    for (const remaining of [0, 1, 2]) {
      for (const throwsThisPoint of [0, 1]) {
        for (const receiving of [true, false]) {
          for (const stoppedThisPossession of [false, true]) {
          // ours/theirs pairs: early, mid, a tight endgame, a blowout endgame.
          for (const [ours, theirs] of [[0, 0], [3, 2], [5, 5], [5, 4], [4, 5], [6, 2]]) {
            const r: TimeoutRead = {
              stall, stallMax: 10, remaining, throwsThisPoint, receiving,
              stoppedThisPossession, ours, theirs, toWin: 7,
            };
            timeoutCases.push({ ...r, want: timeoutIntent(r) });
          }
          }
        }
      }
    }
  }

  return {
    note:
      'Playbook geometry from src/sim/Playbook.ts. Pure arithmetic throughout, so '
      + 'bit-exact except where Math.hypot (dist2, markPoint) or Math.exp (sigmoid) '
      + 'is involved. Generated by tools/goldens/playbook.ts.',
    constants,
    clampCases,
    lerpCases,
    smoothstepCases,
    dist2Cases,
    sigmoidCases,
    clampToFieldCases,
    inBoundsCases,
    goalCases,
    handSideSignCases,
    openSideSignCases,
    openSideForCases,
    releaseSideTypeCases,
    stackColumnXCases,
    formationStationsCases,
    handlerCountCases,
    chooseFormationCases,
    laneOfCases,
    buildCutCases,
    markPointCases,
    zoneStationsCases,
    shouldPlayZoneCases,
    weather: {
      windyChance: WEATHER.windyChance,
      calmAcross: WEATHER.calmAcross,
      calmAlong: WEATHER.calmAlong,
      windyMin: WEATHER.windyMin,
      windyMax: WEATHER.windyMax,
      panicBefore: TIMEOUT_PLAY.panicBefore,
      setPlayStall: TIMEOUT_PLAY.setPlayStall,
    },
    weatherCases,
    timeoutCases,
  };
}
