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
export type MarkerStatus = 'legal' | 'out-of-range' | 'disc-space' | 'double-team' | 'none';

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
  /**
   * Radius of the double-team rule, metres. USAU 16.G is written in feet:
   * "within ten feet of any pivot of the thrower". 10 ft = 3.048 m.
   */
  doubleTeamRange: number;
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

  /**
   * THE MATCH CLOCK, and it is off by default.
   *
   * Timed play is the other half of the caps `applySoftCap` / `applyHardCap`
   * already implement and nothing ever called. Seconds of `GameState.clock` at
   * which each lands; 0 means that cap never fires, so a game with both at 0 —
   * every game the sim has ever played — is untimed and behaves exactly as it
   * always has.
   *
   * The two are independent, which is how the sport writes them: the soft cap
   * moves the target to the leader + 1 and play carries on, and the hard cap
   * makes the point in progress the last one. Setting only `hardCapAt` is a
   * legal (if brutal) format.
   */
  softCapAt: number;
  hardCapAt: number;

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
  /**
   * Gaining possession in the endzone you are DEFENDING => walk it out to the
   * goal line (USAU 12.A.2).
   *
   * Unlike 12.B this is a CHOICE the rules give the player: 12.A.1 lets him
   * establish a pivot on the spot instead, and faking or pausing commits him to
   * doing exactly that. The sim always takes the walk, because the alternative
   * is throwing from inside your own endzone, where the mark has a sideline and
   * an end line helping it and a turnover is very nearly a goal against. Real
   * teams take the walk for the same reason.
   */
  walkOutOfDefendingEndzone: boolean;
  /** Emit disc:released / disc:caught / disc:grounded as well as rules events. */
  emitPhysicsEvents: boolean;
}

export const DEFAULT_RULES: RuleSet = {
  stallMax: 10,
  stallInterval: 1,
  stallResumeCap: 9,
  markerRange: 3,
  discSpace: 0.274, // one disc diameter (WFDF 18.1)
  doubleTeamRange: 3.048, // ten feet (USAU 16.G)
  travelTolerance: 0.35,

  gameTo: 15,
  halftimeAt: 8,
  winBy: 1,
  pointCap: 17,
  softCapAt: 0,
  hardCapAt: 0,

  timeoutsPerHalf: 2,
  timeoutDuration: 70,
  defenseMayCallTimeout: false,

  postScoreDelay: 3,
  halftimeDuration: 300,

  swapEndsAtHalftime: true,
  walkToGoalLineFromAttackingEndzone: true,
  walkOutOfDefendingEndzone: true,
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
 *
 *  - always on or inside the perimeter (out-of-bounds discs come in at the spot
 *    where they crossed — WFDF 13.2);
 *  - possession gained in the endzone you are ATTACKING, other than by scoring,
 *    is carried to the nearest point on that goal line (USAU 12.B). Mandatory:
 *    "the player in possession must carry the disc directly to, and put it into
 *    play at, the spot on the goal line closest to where the player stopped";
 *  - possession gained in the endzone you are DEFENDING may be walked out to
 *    the nearest point on that goal line (USAU 12.A.2).
 *
 * THE TWO ARE NOT THE SAME RULE and only the first was here. 12.B is
 * compulsory; 12.A is a choice between putting it into play on the spot
 * (12.A.1) and walking it to the line (12.A.2), and the sim always takes the
 * walk — see `walkOutOfDefendingEndzone`.
 *
 * Both walk to the goal line of the endzone the disc is IN, which is why the
 * two branches differ only in sign. `x` never moves: the closest point on a
 * goal line is straight out of it.
 */
export function putIntoPlaySpot(spot: Vec3, attackDir: Dir, rules: RuleSet): Vec3 {
  const p = clampToField(spot);
  const zone = p.z * attackDir;
  if (rules.walkToGoalLineFromAttackingEndzone && zone >= FIELD.GOAL_LINE - G_EPS) {
    p.z = goalLineZ(attackDir);
  } else if (rules.walkOutOfDefendingEndzone && zone <= -(FIELD.GOAL_LINE - G_EPS)) {
    p.z = goalLineZ(-attackDir as Dir);
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

/**
 * USAU 16.G — DOUBLE TEAM. Returns the offending defender, or null.
 *
 *   "a defensive player within ten feet of any pivot of the thrower without
 *    also being within ten feet of, and guarding, another offensive player"
 *
 * Two halves, and the second is the one that is easy to miss: a second body
 * near the disc is only a double team if he is not there for somebody else.
 * A defender whose own matchup has cut through the area is legitimately close
 * and is not double teaming, which is exactly why the rule is written as an
 * exception rather than as a simple radius.
 *
 * The marker himself is never the offender — he is the one player entitled to
 * be there — so he is excluded rather than counted.
 */
export function doubleTeamOffender(
  pivot: Vec3,
  markerId: PlayerId | null,
  defenders: readonly { id: PlayerId; pos: Vec3 }[],
  offence: readonly { id: PlayerId; pos: Vec3 }[],
  throwerId: PlayerId | null,
  rules: RuleSet,
): PlayerId | null {
  const r = rules.doubleTeamRange;
  for (const d of defenders) {
    if (d.id === markerId) continue;
    if (distXZ(d.pos, pivot) > r + G_EPS) continue;
    let excused = false;
    for (const o of offence) {
      if (o.id === throwerId) continue;
      if (distXZ(d.pos, o.pos) <= r + G_EPS) { excused = true; break; }
    }
    if (!excused) return d.id;
  }
  return null;
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

/* ------------------------------------------------ contact and the calling */

/**
 * SELF-OFFICIATION — the detection half.
 *
 * `GameState.makeCall` / `resolveCall` have always known what to DO with a foul,
 * a pick or a strip. Nothing ever made one, because nothing in the sim looked at
 * two bodies and decided that what happened between them was worth stopping play
 * for. These are that decision, and they are here rather than in the engine for
 * the same reason `isTravel` is: they are pure geometry over two bodies, and the
 * engine's job is only to supply the bodies and to live with the answer.
 *
 * THE DESIGN CONSTRAINT IS RARITY, and it is not a threshold — it is what gets
 * measured. A real 7v7 game has one to three calls in it, and the honest way to
 * land there is to ask the question a player asks, which is never "did we touch"
 * but "did that touch change what was about to happen". So:
 *
 *   - a marking foul is contact the MARKER drove into a thrower who is standing
 *     on his pivot and cannot move out of the way;
 *   - a pick is an obstruction that COST the defender — he lost speed and his
 *     matchup gained ground over the same moment;
 *   - a receiving foul / strip is contact at the instant a catch failed.
 *
 * Measured over three fifteen-minute 7v7 matches, bare body contact between the
 * mark and the thrower happens 4-8 times and a defender brushes a body that is
 * not his matchup 200-280 times. Neither of those is a call. The predicates
 * below cut them to roughly one and two respectively, which is the sport's own
 * number rather than a tuned one.
 */

/** A body as the contact model needs it. */
export interface ContactBody {
  id: PlayerId;
  pos: Vec3;
  vel: Vec3;
  /** Shoulder half-width, the same radius the hard contact tier separates on. */
  radius: number;
}

export interface Contact {
  /** Centre-to-centre distance in XZ, metres. */
  dist: number;
  /** True when the two bodies overlap. */
  touching: boolean;
  /**
   * Closing speed of whichever body was closing harder, m/s. The same quantity
   * `Locomotion.contactReaction` calls `impact` — a body standing still while
   * somebody runs into it registers the runner's speed, not zero.
   */
  impact: number;
  /** Who was closing harder: the one who ran into the other. */
  aggressorId: PlayerId;
}

export function contactBetween(a: ContactBody, b: ContactBody): Contact {
  const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const touching = d < a.radius + b.radius;
  if (d < 1e-6) return { dist: d, touching, impact: 0, aggressorId: a.id };
  const nx = dx / d, nz = dz / d;
  const closeA = a.vel.x * nx + a.vel.z * nz;
  const closeB = -(b.vel.x * nx + b.vel.z * nz);
  return {
    dist: d,
    touching,
    impact: Math.max(closeA, closeB),
    aggressorId: closeA >= closeB ? a.id : b.id,
  };
}

/**
 * Closing speed at which contact on the thrower stops being incidental, m/s.
 *
 * The thrower on his pivot is immovable — see `Locomotion.invMass` — so a mark
 * that walks into him is not resolved by physics at all; it is resolved by this.
 * 0.8 m/s is a step taken into a stationary man rather than a lean.
 */
export const MARK_FOUL_IMPACT = 0.8;

/**
 * Speed a defender must lose to an obstruction before it is worth calling (m/s),
 * and the ground his matchup must gain over the same moment (m).
 *
 * Both, not either. A defender who slows behind a body but stays with his man
 * was not picked, and one whose man pulls away while he is running free was
 * simply beaten.
 */
export const PICK_SPEED_LOSS = 0.9;
export const PICK_GAP_GAIN = 0.25;

/** Closing speed at which contact through a catch attempt is a foul, m/s. */
export const CATCH_FOUL_IMPACT = 1.0;

/**
 * WFDF 17.1 / USAU 15.B — the marker may not make contact with the thrower.
 *
 * Returns the impact when there is a call, 0 when there is not. Gated on the
 * marker being the one closing: a thrower who backs into his mark has fouled
 * nobody, and on his pivot he can hardly do even that.
 */
export function markingFoulImpact(marker: ContactBody, thrower: ContactBody): number {
  const c = contactBetween(marker, thrower);
  if (!c.touching) return 0;
  if (c.aggressorId !== marker.id) return 0;
  return c.impact >= MARK_FOUL_IMPACT ? c.impact : 0;
}

/**
 * THE PICK — "the game's most common call", and the one that needs a cost.
 *
 * A defender is obstructed when an offensive body who is neither the thrower nor
 * his own matchup is inside him. That alone is worth nothing: it happens two
 * hundred times a match and almost none of it matters. What makes it a call is
 * that the obstruction took something — `lostSpeed` is what he was doing when he
 * ran into the body minus what he is doing now, `gainedGap` is how much further
 * away his matchup is than when it started.
 */
export function pickIsWorthCalling(lostSpeed: number, gainedGap: number): boolean {
  return lostSpeed >= PICK_SPEED_LOSS && gainedGap >= PICK_GAP_GAIN;
}

/**
 * Who obstructed this defender, if anybody. `offence` should exclude nobody —
 * the thrower and the defender's own matchup are filtered here so the caller
 * cannot forget to.
 */
export function obstructionOf(
  defender: ContactBody,
  offence: readonly ContactBody[],
  throwerId: PlayerId | null,
  matchupId: PlayerId | null,
): PlayerId | null {
  for (const o of offence) {
    if (o.id === throwerId || o.id === matchupId) continue;
    if (contactBetween(defender, o).touching) return o.id;
  }
  return null;
}

/**
 * How long after a hit a failed catch can still be blamed on it, seconds.
 *
 * The contact and the incompletion are not the same tick and cannot be. The hard
 * contact resolver runs during locomotion and has already spent the closing
 * velocity by the time the disc is stepped — measured over three matches, every
 * defender still inside a receiver at the moment of a drop had a *post-impulse*
 * closing speed of 0.0-0.5 m/s, because the impulse is exactly what removed it.
 * Deriving the foul from the geometry at the catch therefore finds nothing, ever,
 * and the honest reading of that is not "there are no receiving fouls" but "you
 * are asking the wrong tick".
 *
 * So the call is made from `Locomotion`'s own contact event, which carries the
 * impact BEFORE the impulse and the id of whoever was closing harder, and this is
 * how long that event stays live. A fifth of a second is the width of a catch.
 */
export const CATCH_CONTACT_WINDOW = 0.2;

/**
 * WHAT A DEFENDER'S CONTACT AT THE CATCH IS.
 *
 *   - he was playing the disc and hit the body anyway => a receiving foul, and
 *     the pass does not stand;
 *   - he was not playing the disc at all and the receiver put it down => a
 *     STRIP: he went through the man to get to a disc that was already caught.
 *
 * Null when the contact is too soft to have decided anything. `impact` is the
 * closing speed `Locomotion` measured at the collision, not a re-derivation.
 */
export function catchContactCall(
  impact: number,
  defenderPlayedDisc: boolean,
  possessionEstablished: boolean,
): { kind: 'foul' | 'strip'; impact: number } | null {
  if (impact < CATCH_FOUL_IMPACT) return null;
  if (!defenderPlayedDisc && possessionEstablished) return { kind: 'strip', impact };
  return { kind: 'foul', impact };
}

/**
 * CONTESTED OR NOT, AND NOT A COIN FLIP.
 *
 * The player a call is made against contests it when he has a basis to, and the
 * basis is the situation: how much contact there actually was (a lot of it is
 * undeniable and nobody argues), whether he had a hand on the disc (the "all
 * disc" defence, which is the single most common reason a real foul call is
 * contested), whether the call is a geometry both players can see — a pick is,
 * a body foul is not — and his own `decision` rating, because reading the play
 * correctly includes reading your own contact correctly.
 *
 * Deterministic on purpose. No RNG is drawn here, which is also why adding the
 * whole system shifts no other stream.
 */
export interface CallSituation {
  /** Closing speed of the contact, m/s. */
  impact: number;
  /** The impact at which this kind of contact became a call. */
  threshold: number;
  /** The defender had a hand on the disc. */
  playedDisc: boolean;
  /** The call is a geometry, not a feeling. */
  plainToSee: boolean;
  /** `decision` rating of the player the call is made against, 0..100. */
  decision: number;
}

/**
 * How much basis the player called against has to contest. >0.5 and he does.
 *
 * The numbers, and why they are where they are:
 *
 *   0.60 base            contact at exactly the threshold is arguable, and the
 *                        argument is settled by the terms below.
 *   -0.55 × severity     severity runs from 0 at the threshold to 1 at
 *                        `CALL_SEVERITY_SPAN` above it. A defender who ran
 *                        through somebody at speed knows he did, and says so.
 *                        Measured across three matches, marking contact lands
 *                        between 1 and 4 m/s, so this span is what actually
 *                        separates a brush from a collision — normalising by the
 *                        threshold instead put every real call at full severity
 *                        and nothing was ever contested.
 *   +0.30 played disc    "all disc" — the commonest reason a real call is
 *                        contested, and the one the sport argues about most.
 *   -0.25 plain to see   a pick is a geometry both players can point at, which
 *                        is why picks are effectively never contested here, and
 *                        why they are effectively never contested on a field.
 *   ±(72 - decision)     judgement, centred on the roster's mean rating: a
 *                        player who reads the game well reads his own contact
 *                        well, and a player who does not, argues.
 *
 * The spread of that last term over the roster (about ±0.19) is deliberately
 * wide enough to decide a marginal call and narrow enough that it cannot
 * overturn an obvious one.
 */
export const CALL_SEVERITY_SPAN = 2.0;

export function callDoubt(s: CallSituation): number {
  const severity = s.threshold > 0
    ? Math.min(1, Math.max(0, (s.impact - s.threshold) / CALL_SEVERITY_SPAN))
    : 0;
  let doubt = 0.60 - 0.55 * severity;
  if (s.playedDisc) doubt += 0.30;
  if (s.plainToSee) doubt -= 0.25;
  doubt += (72 - s.decision) * 0.007;
  return doubt;
}

export function callContested(s: CallSituation): boolean {
  return callDoubt(s) > 0.5;
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
