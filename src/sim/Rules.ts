/**
 * ULTIMATE — rules primitives (WFDF 2021 / USAU 11th ed., 7v7 outdoor).
 *
 * Everything in this file is a constant or a pure function: no state, no clock,
 * no RNG, no THREE import. That makes it safe to call from a fixed 1/120 s step
 * and trivial to unit test. `GameState.ts` layers the state machine on top.
 *
 * Coordinate frame (matches BRIEF.md): origin at field centre, Y up,
 * +Z toward one endzone, X across.
 *
 *        x = -18.5                          x = +18.5
 *   z=+50 +--------------- end line ---------------+
 *         |            endzone (18 m)              |
 *   z=+32 +---------------- goal line -------------+
 *   z=+14 .                  brick                 .
 *         |          playing field proper          |
 *   z=  0 .                 centre                 .
 *   z=-14 .                  brick                 .
 *   z=-32 +---------------- goal line -------------+
 *         |            endzone (18 m)              |
 *   z=-50 +--------------- end line ---------------+
 */

/* ------------------------------------------------------------------- types */

export interface Vec3 { x: number; y: number; z: number }

export type TeamId = 0 | 1;
export type PlayerId = number;
/** Attacking direction: +1 = scoring in the +Z endzone, -1 = the -Z endzone. */
export type Dir = 1 | -1;

export type Edge = 'sideline+x' | 'sideline-x' | 'endline+z' | 'endline-z';

/** Whether the marker may legally run a stall count this instant. */
export type MarkerStatus = 'legal' | 'out-of-range' | 'disc-space' | 'none';

/* ------------------------------------------------------------------- field */

/** Regulation field, metres. LENGTH = CENTRAL_LENGTH + 2 * ENDZONE_DEPTH. */
export const FIELD = {
  /** End line to end line. */
  LENGTH: 100,
  /** Sideline to sideline. */
  WIDTH: 37,
  ENDZONE_DEPTH: 18,
  /** "Playing field proper" — goal line to goal line. */
  CENTRAL_LENGTH: 64,
  /** |z| of either goal line. */
  GOAL_LINE: 32,
  /** |z| of either end line. */
  END_LINE: 50,
  /** |x| of either sideline. */
  SIDELINE: 18.5,
  /** Brick mark is this far in from the goal line. */
  BRICK_IN: 18,
  /** |z| of either brick mark (on the centre line, x = 0). */
  BRICK_Z: 14,
} as const;

/** The eight cone positions (four field corners + four goal-line corners). */
export const CONES: readonly Vec3[] = Object.freeze([
  { x: -FIELD.SIDELINE, y: 0, z: -FIELD.END_LINE },
  { x: +FIELD.SIDELINE, y: 0, z: -FIELD.END_LINE },
  { x: -FIELD.SIDELINE, y: 0, z: -FIELD.GOAL_LINE },
  { x: +FIELD.SIDELINE, y: 0, z: -FIELD.GOAL_LINE },
  { x: -FIELD.SIDELINE, y: 0, z: +FIELD.GOAL_LINE },
  { x: +FIELD.SIDELINE, y: 0, z: +FIELD.GOAL_LINE },
  { x: -FIELD.SIDELINE, y: 0, z: +FIELD.END_LINE },
  { x: +FIELD.SIDELINE, y: 0, z: +FIELD.END_LINE },
]);

/** The field is metric; stats are stored in metres. Multiply for a US display. */
export const YARDS_PER_METRE = 1.0936133;

/** Floating point slack for "elapsed >= n * interval" comparisons. */
const T_EPS = 1e-9;
/** Geometric slack, metres. */
const G_EPS = 1e-9;

/* ------------------------------------------------------------------- rules */

export interface RuleSet {
  /** Count that constitutes a stall-out. Marker counts "stalling one … ten". */
  stallMax: number;
  /** Seconds between counts. */
  stallInterval: number;
  /** After a stoppage the count resumes at reached+1, capped here. */
  stallResumeCap: number;
  /** Marker must be within this of the thrower for the count to run (m). */
  markerRange: number;
  /** Marker may not come closer than this — one disc diameter (m). */
  discSpace: number;
  /** How far the pivot foot may slip before it is a travel (m). */
  travelTolerance: number;

  /** Points required to win. */
  gameTo: number;
  /** Halftime when either team reaches this. */
  halftimeAt: number;
  /** Margin required to win (1 = normal, 2 = win-by-two variants). */
  winBy: number;
  /** Absolute ceiling for a win-by-two game. */
  pointCap: number;

  timeoutsPerHalf: number;
  /** Seconds a timeout lasts before play must restart. */
  timeoutDuration: number;
  /** Only the team in possession may call a timeout during a point. */
  defenseMayCallTimeout: boolean;

  /** Seconds the machine sits in POINT_SCORED before setting up the next pull. */
  postScoreDelay: number;
  /** Seconds of halftime. */
  halftimeDuration: number;

  /** Teams change ends at halftime (in addition to the per-point direction flip). */
  swapEndsAtHalftime: boolean;
  /** Gaining possession in your attacking endzone => carry to the goal line. */
  walkToGoalLineFromAttackingEndzone: boolean;
  /** Emit disc:released / disc:caught / disc:grounded as well as rules events. */
  emitPhysicsEvents: boolean;
}

export const DEFAULT_RULES: RuleSet = {
  stallMax: 10,
  stallInterval: 1,
  stallResumeCap: 9,
  markerRange: 3,
  discSpace: 0.274, // one disc diameter (WFDF 18.1)
  travelTolerance: 0.35,

  gameTo: 15,
  halftimeAt: 8,
  winBy: 1,
  pointCap: 17,

  timeoutsPerHalf: 2,
  timeoutDuration: 70,
  defenseMayCallTimeout: false,

  postScoreDelay: 3,
  halftimeDuration: 300,

  swapEndsAtHalftime: true,
  walkToGoalLineFromAttackingEndzone: true,
  emitPhysicsEvents: true,
};

export function makeRules(over?: Partial<RuleSet>): RuleSet {
  return over ? { ...DEFAULT_RULES, ...over } : { ...DEFAULT_RULES };
}

/* ---------------------------------------------------------------- geometry */

export function v3(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; }
export function copy(p: Vec3): Vec3 { return { x: p.x, y: p.y, z: p.z }; }

export function distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Perimeter lines count as in-bounds for the disc; a point strictly beyond is out. */
export function isInBounds(p: Vec3): boolean {
  return Math.abs(p.x) <= FIELD.SIDELINE + G_EPS && Math.abs(p.z) <= FIELD.END_LINE + G_EPS;
}

/** +1 / -1 if inside that endzone, 0 if between the goal lines. Ignores bounds in X. */
export function endzoneOf(z: number): Dir | 0 {
  if (z >= FIELD.GOAL_LINE - G_EPS) return 1;
  if (z <= -FIELD.GOAL_LINE + G_EPS) return -1;
  return 0;
}

/** True when p is inside the endzone at the `dir` end and between the sidelines. */
export function isInEndzone(p: Vec3, dir: Dir): boolean {
  return isInBounds(p) && p.z * dir >= FIELD.GOAL_LINE - G_EPS;
}

/** A goal: an in-bounds catch in the endzone this team attacks. */
export function isGoal(p: Vec3, attackDir: Dir): boolean {
  return isInEndzone(p, attackDir);
}

/** z of the goal line at the `dir` end. */
export function goalLineZ(dir: Dir): number { return dir * FIELD.GOAL_LINE; }

/**
 * The brick mark a team uses when the pull lands out of bounds: on the centre
 * line, BRICK_IN metres in from the goal line of the endzone they are DEFENDING
 * (WFDF 12.4). For attackDir = +1 that is z = -14.
 */
export function brickMark(attackDir: Dir): Vec3 {
  return { x: 0, y: 0, z: attackDir * (FIELD.BRICK_IN - FIELD.GOAL_LINE) };
}

export function clampToField(p: Vec3): Vec3 {
  return {
    x: Math.min(FIELD.SIDELINE, Math.max(-FIELD.SIDELINE, p.x)),
    y: 0,
    z: Math.min(FIELD.END_LINE, Math.max(-FIELD.END_LINE, p.z)),
  };
}

export interface Crossing { point: Vec3; edge: Edge; t: number }

/**
 * Where segment a->b leaves the field rectangle. Returns null when the segment
 * never exits. Deterministic: ties resolve in sideline-then-endline order.
 */
export function boundaryCrossing(a: Vec3, b: Vec3): Crossing | null {
  let bestT = Infinity;
  let bestEdge: Edge | null = null;

  const consider = (num: number, den: number, edge: Edge) => {
    if (Math.abs(den) < 1e-12) return;
    const t = num / den;
    if (t < 0 || t > 1 || t >= bestT) return;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (edge === 'sideline+x' || edge === 'sideline-x') {
      if (Math.abs(z) > FIELD.END_LINE + 1e-9) return;
    } else if (Math.abs(x) > FIELD.SIDELINE + 1e-9) return;
    bestT = t; bestEdge = edge;
  };

  consider(FIELD.SIDELINE - a.x, b.x - a.x, 'sideline+x');
  consider(-FIELD.SIDELINE - a.x, b.x - a.x, 'sideline-x');
  consider(FIELD.END_LINE - a.z, b.z - a.z, 'endline+z');
  consider(-FIELD.END_LINE - a.z, b.z - a.z, 'endline-z');

  if (bestEdge === null) return null;
  return {
    point: { x: a.x + (b.x - a.x) * bestT, y: 0, z: a.z + (b.z - a.z) * bestT },
    edge: bestEdge,
    t: bestT,
  };
}

/**
 * Where a team putting the disc into play establishes its pivot.
 *  - always on or inside the perimeter (out-of-bounds discs come in at the spot
 *    where they crossed — WFDF 13.2);
 *  - possession gained in the endzone you are ATTACKING is carried to the
 *    nearest point on that goal line (USAU 12.B) when the rule is enabled.
 */
export function putIntoPlaySpot(spot: Vec3, attackDir: Dir, rules: RuleSet): Vec3 {
  const p = clampToField(spot);
  if (rules.walkToGoalLineFromAttackingEndzone && p.z * attackDir >= FIELD.GOAL_LINE - G_EPS) {
    p.z = goalLineZ(attackDir);
  }
  return p;
}

/* ------------------------------------------------------------------- stall */

/** Stall number for an elapsed marking time. 0 means "no count yet". */
export function stallCountFor(elapsed: number, rules: RuleSet): number {
  if (elapsed <= 0) return 0;
  const n = Math.floor(elapsed / rules.stallInterval + T_EPS);
  return Math.min(rules.stallMax, Math.max(0, n));
}

/** Elapsed marking time that corresponds exactly to a given count. */
export function stallElapsedFor(count: number, rules: RuleSet): number {
  return Math.max(0, count) * rules.stallInterval;
}

/** After a stoppage the count restarts at reached+1, capped (WFDF 18.4). */
export function resumeStallCount(count: number, rules: RuleSet): number {
  return Math.min(rules.stallResumeCap, Math.max(0, count) + 1);
}

/** Marker legality: must be inside markerRange and no closer than discSpace. */
export function markerStatus(markerPos: Vec3 | null, throwerPos: Vec3, rules: RuleSet): MarkerStatus {
  if (!markerPos) return 'none';
  const d = distXZ(markerPos, throwerPos);
  if (d > rules.markerRange) return 'out-of-range';
  if (d < rules.discSpace) return 'disc-space';
  return 'legal';
}

/** The pivot foot has left its spot by more than the tolerance. */
export function isTravel(pivot: Vec3, foot: Vec3, rules: RuleSet): boolean {
  return distXZ(pivot, foot) > rules.travelTolerance;
}

/* ------------------------------------------------------------ score / caps */

export type CapState = 'none' | 'soft' | 'hard';

/**
 * The score a team must reach. Soft cap (time cap during a point) sets the
 * target to the current leader + 1; hard cap ends the game on the next goal.
 */
export function effectiveTarget(score: readonly [number, number], rules: RuleSet, cap: CapState): number {
  const lead = Math.max(score[0], score[1]);
  if (cap === 'hard') return lead + 1;
  if (cap === 'soft') return Math.min(rules.pointCap, lead + 1);
  return rules.gameTo;
}

export function isGameOver(score: readonly [number, number], target: number, rules: RuleSet, cap: CapState): boolean {
  const hi = Math.max(score[0], score[1]);
  const margin = Math.abs(score[0] - score[1]);
  if (hi >= rules.pointCap && margin >= 1) return true;
  if (cap === 'hard') return hi >= target && margin >= 1;
  return hi >= target && margin >= rules.winBy;
}

export function flipDir(d: Dir): Dir { return (d === 1 ? -1 : 1); }
export function otherTeam(t: TeamId): TeamId { return (t === 0 ? 1 : 0); }
