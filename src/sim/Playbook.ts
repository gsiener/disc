/**
 * Playbook — the *geometry* of ultimate frisbee.
 *
 * Field constants, force/side algebra, offensive formations, cut-route
 * templates, zone shells and mark geometry. Everything here is a pure function
 * of numbers: no engine imports, no THREE, no `Math.random`, no mutable module
 * state. `AI.ts` is the intended consumer; `Locomotion.ts` / HUD may import the
 * types freely.
 *
 * Coordinate convention (matches BRIEF.md):
 *   origin  = field centre
 *   +X      = one sideline direction, |x| <= 18.5
 *   +Y      = up
 *   +Z      = toward the endzone team 0 attacks, |z| <= 50
 *   goal lines at z = +/-32, endzones 18 deep, brick marks at z = +/-14.
 *
 * A team's `AttackDir` is +1 or -1: the sign of the endzone they are scoring in.
 */

/* ------------------------------------------------------------------ basics */

export interface Vec2 { x: number; z: number }
export interface Vec3 { x: number; y: number; z: number }

export type Sign = -1 | 1;
export type AttackDir = -1 | 1;
export type Handedness = 'right' | 'left';

/**
 * The call the defence makes.
 *
 * The first three are FIXED to a side of the field for the whole point, which
 * is how a team calls "force home" or "force flick": the open side does not
 * move when the disc does. `straight` is a straight-up mark that takes neither
 * side (and mostly takes away the huck).
 *
 * The last two are POSITION-DEPENDENT and cannot be expressed by
 * `openSideSign`, which is why they need `openSideFor`:
 *
 *   `middle`   — force the disc back toward the middle of the field. The mark
 *                takes away the sideline the disc is nearest, so the open side
 *                always points at x = 0. This is the standard answer to a team
 *                that attacks the lines, and it keeps the disc where the whole
 *                defence can see it.
 *   `sideline` — the trap. The mirror of `middle`: take away the middle and
 *                invite the throw down the near line, where the sideline itself
 *                does half the defending. Called to pin a team after a turnover
 *                or on a windward line.
 */
export type Force = 'forehand' | 'backhand' | 'straight' | 'middle' | 'sideline';

/** Forces whose open side depends on where the disc is, not on the call alone. */
export const POSITIONAL_FORCES: readonly Force[] = ['middle', 'sideline'];

/**
 * How far off centre the disc must be before a positional force commits to a
 * side. Inside this band the previous call is held.
 *
 * Without it, force middle flips every time the disc crosses x = 0 — and the
 * open side is what the whole offence is built on, so a force that chatters
 * makes the stack, the reset and the mark all rebuild several times a second.
 * Real teams have the same problem and solve it the same way: with the disc in
 * the middle of the field a middle force is barely a force at all, and the mark
 * simply holds whichever side it already had.
 */
export const FORCE_DEADBAND = 3.0;

export type FormationName = 'vertical' | 'horizontal' | 'side' | 'endzone';

export type CutKind =
  | 'under'        // downfield cutter comes back toward the disc, open side
  | 'break-under'  // same but attacking the side the mark is taking away
  | 'deep'         // downfield cutter attacks the space behind the defence
  | 'strike'       // short, sharp cut to the front cone in the endzone set
  | 'up-line'      // handler attacks the space up the line, open side
  | 'dump'         // handler reset behind the disc
  | 'swing';       // handler reset that changes the angle of attack

/**
 * A "lane" is the piece of field a cut consumes. Two live cuts may never share
 * one — that is what stops the offence from clogging.
 */
export type LaneKey =
  | 'open-under' | 'open-deep'
  | 'break-under' | 'break-deep'
  | 'reset-open' | 'reset-break';

export const ALL_LANES: readonly LaneKey[] = [
  'open-under', 'open-deep', 'break-under', 'break-deep', 'reset-open', 'reset-break',
];

export const FIELD = {
  /** Half of the 37 m playing width. */
  halfWidth: 18.5,
  /** Half of the 100 m total length (64 central + 2 x 18 endzone). */
  halfLength: 50,
  /** |z| of a goal line. */
  goalLine: 32,
  endzoneDepth: 18,
  /** |z| of a brick mark (18 m in from the goal line). */
  brick: 14,
  /** Players are steered to stay this far inside the perimeter. */
  edgeMargin: 0.9,
} as const;

/** Tunables the AI reads; grouped here so behaviour can be tuned in one place. */
export const PLAY = {
  /** Stack spacing, metres, front-to-back. */
  stackSpacing: 4.2,
  /** How far downfield the front of a vertical stack sits from the disc. */
  stackLead: 11,
  /**
   * How many cutters must still be STANDING IN THE COLUMN before another one
   * is allowed to go. Without this the cut budget plus the clear-out drains
   * the stack completely — every cutter is always either cutting or jogging
   * back — and the offence stops being a shape at all. A stack is the bodies
   * that are not cutting; if there are none, there is no stack, only traffic.
   */
  stackHold: 3,
  /** Max live downfield cuts at once. */
  maxLiveCuts: 2,
  /**
   * Minimum gap between the starts of two cuts, seconds. This is what makes a
   * second cut read as a SECOND cut rather than as two people leaving at once:
   * the first attacks, the defence commits, and the next one goes into what
   * that opened. It is also most of what keeps bodies in the column.
   */
  cutStagger: 1.1,
  /** Setup-step duration before the plant, seconds. */
  setupTime: 0.45,
  /** Plant / change-of-direction duration, seconds. */
  plantTime: 0.16,
  /**
   * A cut is abandoned after this long.
   *
   * `underCutTime` HAS TO COVER THE CANONICAL UNDER, which is the longest cut
   * in the sport that is not a huck: the back of the stack coming all the way
   * back to the disc. The back cutter stands at `stackLead + 4 * stackSpacing`
   * = 27.8 m downfield and the under resolves 5.5-9.5 m in front of the disc,
   * so the run is 18-22 m. From a standing start that is 3.0-3.4 s.
   *
   * At 2.2 s it was structurally impossible — the cut was abandoned with the
   * cutter still six metres short of the disc, every time, so the shape the
   * whole vertical stack exists to create could never actually be thrown to.
   */
  underCutTime: 3.4,
  deepCutTime: 3.2,
  /** Marker stand-off distance and the legal limits either side of it. */
  markDistance: 2.15,
  markMax: 3.0,
  discSpace: 1.0,
  /** Downfield defenders shade this far to the open side of their matchup. */
  shadeOpen: 1.75,
  /** Cushion a defender gives a live deep threat, metres downfield. */
  deepCushion: 2.4,
  /** How far under a defender plays a cutter who is not a deep threat. */
  underGap: 0.9,
} as const;

/* ------------------------------------------------------------------- maths */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

export const dist2 = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

export const distSq2 = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
};

/** Signed logistic in [0,1]; `k` is the steepness. */
export const sigmoid = (x: number, k = 1): number => 1 / (1 + Math.exp(-k * x));

/** Squeeze a point inside the playing surface. Returns a new object. */
export function clampToField(p: Vec2, margin: number = FIELD.edgeMargin): Vec2 {
  return {
    x: clamp(p.x, -FIELD.halfWidth + margin, FIELD.halfWidth - margin),
    z: clamp(p.z, -FIELD.halfLength + margin, FIELD.halfLength - margin),
  };
}

export function inBounds(x: number, z: number, margin = 0): boolean {
  return Math.abs(x) <= FIELD.halfWidth - margin && Math.abs(z) <= FIELD.halfLength - margin;
}

/** Metres from `z` to the goal line the team attacks. Negative once in the endzone. */
export const yardsToGoal = (z: number, dir: AttackDir): number => FIELD.goalLine - dir * z;

export const inAttackEndzone = (z: number, dir: AttackDir): boolean => dir * z >= FIELD.goalLine;

export const inOwnEndzone = (z: number, dir: AttackDir): boolean => dir * z <= -FIELD.goalLine;

/* --------------------------------------------------------- force / sides */

/**
 * X sign of a player's forehand side while facing `dir`.
 *
 * three.js is right-handed with +Y up, so a player facing +Z has their right
 * hand at -X (right = forward x up = (0,0,1) x (0,1,0) = (-1,0,0)).
 */
export function handSideSign(handed: Handedness, dir: AttackDir): Sign {
  const rightHandX = (-dir) as Sign;
  return handed === 'right' ? rightHandX : (-rightHandX as Sign);
}

/**
 * X sign of the OPEN side — the side the force invites throws toward — for a
 * team attacking `dir`. Defined against a right-handed reference thrower, which
 * is how real teams call it: the call is fixed to a side of the field for the
 * whole point ("force home"), not re-derived per thrower.
 */
export function openSideSign(force: Force, dir: AttackDir): Sign {
  if (force === 'straight') return (-dir) as Sign;
  // A positional force has no fixed side; this is only its neutral prior, and
  // callers that can see the disc must use `openSideFor` instead.
  if (force === 'middle' || force === 'sideline') return (-dir) as Sign;
  const forehandX = handSideSign('right', dir);
  return force === 'forehand' ? forehandX : (-forehandX as Sign);
}

/**
 * The open side, for a force that may depend on where the disc is.
 *
 * `discX` is the thrower's x. `prev` is the side this defence last committed
 * to; pass it and the deadband is honoured, pass null and the call is taken
 * fresh. For the three fixed forces this is exactly `openSideSign`.
 *
 * Note which way round these are. FORCE MIDDLE means the throw is invited
 * toward the middle, so the mark stands between the thrower and the near
 * sideline and the open side points at x = 0 — a disc on the +X line has its
 * open side at -X. The trap is the mirror: the mark takes the middle away and
 * the offence is invited down the line it is already stuck on.
 */
export function openSideFor(
  force: Force, dir: AttackDir, discX: number, prev: Sign | null = null,
): Sign {
  if (force !== 'middle' && force !== 'sideline') return openSideSign(force, dir);
  if (prev !== null && Math.abs(discX) < FORCE_DEADBAND) return prev;
  const towardMiddle = (discX > 0 ? -1 : 1) as Sign;
  return force === 'middle' ? towardMiddle : (-towardMiddle as Sign);
}

/** Break side for a force that may depend on where the disc is. */
export const breakSideFor = (
  force: Force, dir: AttackDir, discX: number, prev: Sign | null = null,
): Sign => -openSideFor(force, dir, discX, prev) as Sign;

/** X sign of the BREAK side — the side the mark is taking away. */
export const breakSideSign = (force: Force, dir: AttackDir): Sign =>
  -openSideSign(force, dir) as Sign;

/**
 * Which throw a release on `releaseSignX` requires, for a thrower of the given
 * handedness facing `dir`. Used to price throw difficulty per player.
 */
export function releaseSideType(
  handed: Handedness, dir: AttackDir, releaseSignX: number,
): 'forehand' | 'backhand' {
  const forehandX = handSideSign(handed, dir);
  return Math.sign(releaseSignX || forehandX) === forehandX ? 'forehand' : 'backhand';
}

/* -------------------------------------------------------------- formations */

export interface Station {
  x: number;
  z: number;
  role: 'handler' | 'cutter';
  /** 0 = closest to the disc within its role group. */
  depth: number;
}

/**
 * Where the seven offensive players want to stand, given the disc position.
 * The thrower is not expected to run to a station — the AI leaves one unused.
 */
/**
 * How far off centre a reset station is ever allowed to sit. The reset is the
 * throw the offence falls back on, so it must be somewhere a disc can be
 * thrown FROM next — and eighteen metres out, hard against a line, is not.
 */
const RESET_BAND = 10.5;
const SWING_BAND = 13.0;
/**
 * How far in front of its own goal line the backfield is allowed to set up.
 * See the floor in `formationStations` — this is what stops a pinned offence
 * dumping itself backwards into its own endzone.
 */
const PIN_MARGIN = 2.0;

/**
 * Lay a backfield row out around an anchor so that every station lands inside
 * the band — by SLIDING THE WHOLE ROW, never by clamping the stations one at a
 * time.
 *
 * Clamping individually is what the three sets used to do, and it collapses the
 * row. With the disc wide at x = 17.4 the endzone set wanted its handlers at
 * 17.0 / 10.5 / 4.0; the first two both hit the 10.5 band and came back as
 * 10.5 / 10.5 / 4.0 — two handlers on the same x, 1.5 m apart in z, which is
 * the 1.69 m pair that `stack keeps >= 2 m between bodies` found. Two players
 * standing on each other is one player and a shadow: the reset and the swing
 * become the same option, and the defence covers both with one body.
 *
 * Sliding preserves the SHAPE and gives up only the tracking, which is the
 * right thing to give up — handlers bringing a wide disc back toward the middle
 * is the behaviour the band exists to produce in the first place.
 */
function backfieldRow(anchor: number, offsets: number[], band: number): number[] {
  let lo = Infinity, hi = -Infinity;
  for (const o of offsets) { if (o < lo) lo = o; if (o > hi) hi = o; }
  // If the row is wider than the band there is nothing to preserve; centre it.
  const centre = hi - lo >= 2 * band ? 0 : clamp(anchor, -band - lo, band - hi);
  return offsets.map((o) => centre + o);
}

/**
 * X of the column a stack set is built on. One source of truth: the formation
 * builds the stack here, the AI clears cutters back to here, and the HUD can
 * draw the same line without guessing.
 */
export function stackColumnX(name: FormationName, a: Vec2, openSign: Sign): number {
  if (name === 'side') return (-openSign as Sign) * 12.5;
  return clamp(a.x * 0.3, -5, 5);
}

export function formationStations(
  name: FormationName, a: Vec2, dir: AttackDir, openSign: Sign,
): Station[] {
  const brk = -openSign as Sign;
  const out: Station[] = [];
  /**
   * A RESET NEVER SETS UP BEHIND YOUR OWN GOAL LINE.
   *
   * Handler stations are placed relative to the disc — `a.z - dir * 6.5` and so
   * on — which is right in the middle of the field and catastrophic when the
   * disc is already on your own line: the dump goes backwards over it, the next
   * one goes further, and the offence walks itself into its own endzone one
   * legal-looking reset at a time. Traced in a real match: a team caught the
   * pull on their own goal line at z=-30.2 and completed passes to -36.1, then
   * -42.1, then -46.4, four metres from their own end line.
   *
   * Real handlers pinned deep go LATERAL, not backward — a swing, not a dump —
   * because backing the disc over your own line is how you hand over a score.
   * So the backfield stations get a floor a couple of metres in front of the
   * line, and the reset flattens into a lateral option exactly when it should.
   *
   * Cutter stations are `a.z + dir * ...` and always downfield, so this floor
   * never touches them.
   */
  const floorZ = -dir * (FIELD.goalLine - PIN_MARGIN);
  const push = (x: number, z: number, role: 'handler' | 'cutter', depth: number): void => {
    const zz = dir > 0 ? Math.max(z, floorZ) : Math.min(z, floorZ);
    const p = clampToField({ x, z: zz });
    out.push({ x: p.x, z: p.z, role, depth });
  };

  switch (name) {
    case 'vertical': {
      // 2 handlers behind, 5 cutters stacked through the middle of the field so
      // both sidelines stay live.
      //
      // Station 0 is THE RESET and it is deliberately first: with two handlers
      // one of them is usually holding the disc, so whichever station gets
      // filled has to be the one a dump can be thrown to. It sits behind the
      // disc on the OPEN side — a reset thrown through the mark is the single
      // most punished decision in the sport, so the reset does not stand there.
      //
      // Both stations are held inside a central band. A reset that simply sits
      // `openSign * 4.5` off a disc already two metres from the line is a reset
      // into the sideline: complete it and the next disc is further out still,
      // and the offence walks itself into the paint and throws it away. Real
      // handlers bring a trapped disc back to the middle, and the geometry has
      // to want that rather than fight it.
      // Coached reset geometry is 45 degrees behind the thrower at about 9 m.
      // The distance here was already right (measured mean 8.80 m); the angle
      // was shallow at 35, so this is 8.8 m at exactly 45.
      const vh = backfieldRow(a.x, [openSign * 4.5, brk * 6.5], RESET_BAND);
      push(vh[0], a.z - dir * 6.5, 'handler', 0);
      push(vh[1], a.z - dir * 3.5, 'handler', 1);
      const sx = stackColumnX('vertical', a, openSign);
      for (let i = 0; i < 5; i++) {
        // Real stacks LEAN, with the back further to the break side. It widens
        // the open-side deep lane the huck runs into, and it stops the column
        // reading as a pure translation of the disc's x. 0.6 m per position is
        // 8.1 degrees off vertical — still unambiguously a line on camera.
        push(sx, a.z + dir * (PLAY.stackLead + PLAY.stackSpacing * i), 'cutter', i);
      }
      break;
    }
    case 'horizontal': {
      // 3 handlers behind, 4 cutters spread the full width 15 m downfield.
      // The handler row is centred on a *clamped* anchor so the outside
      // stations cannot collapse onto each other against a sideline.
      // Coached geometry: the outside handlers sit 10-15 yd (9.1-13.7 m) either
      // side of the middle one. At 7 m "three handlers across the field" read as
      // a huddle rather than as the width the set exists to create.
      const hh = backfieldRow(a.x, [openSign * 10.0, 0, brk * 10.0],
        FIELD.halfWidth - FIELD.edgeMargin);
      /**
       * STATION 0 IS THE RESET, and it must be on the OPEN side.
       *
       * `assignHandlerStations` fills these in order and treats station 0 as
       * the dump — the vertical set is built that way, with station 0 at
       * `openSign * 6.2`. The horizontal set had station 0 on the BREAK side,
       * so the moment ho was enabled the offence nominated a reset standing
       * behind the mark: the one place in the sport a reset may never be.
       *
       * That is what the measured failure was. With ho on, a reset handler was
       * stationed behind the disc in 84.6% of held frames against 90.0% for
       * vert, and was in position at high stall 88.0% against 92.8% — not
       * because three handlers are harder to place, but because the first one
       * placed was on the wrong side of the field.
       *
       * Open side, centre, break side. The break-side handler is the swing.
       */
      push(hh[0], a.z - dir * 5.5, 'handler', 0);
      push(hh[1], a.z - dir * 4.0, 'handler', 1);
      push(hh[2], a.z - dir * 5.5, 'handler', 2);
      const xs = [-13.5, -4.5, 4.5, 13.5];
      for (let i = 0; i < 4; i++) push(xs[i], a.z + dir * 15, 'cutter', i);
      break;
    }
    case 'side': {
      // 5 cutters stacked on the break sideline, isolating the whole open side.
      const sh = backfieldRow(a.x, [openSign * 4.0, brk * 6.0], RESET_BAND);
      push(sh[0], a.z - dir * 6.5, 'handler', 0);
      push(sh[1], a.z - dir * 3.0, 'handler', 1);
      const lx = stackColumnX('side', a, openSign);
      for (let i = 0; i < 5; i++) {
        push(lx, a.z + dir * (9 + PLAY.stackSpacing * i), 'cutter', i);
      }
      break;
    }
    case 'endzone': {
      // 3 handlers behind the disc, 4 cutters spread across the endzone ready
      // to strike to the front cone. They sit a little over half the endzone
      // deep, not against the back line: pinned to the back line they are 25 m
      // from a disc 12 m out, and the team reads as two disconnected knots of
      // people with the whole middle of the field empty between them.
      const eh = backfieldRow(a.x, [openSign * 6.5, 0, brk * 6.5], RESET_BAND);
      push(eh[0], a.z - dir * 5.0, 'handler', 0);
      push(eh[1], a.z - dir * 6.5, 'handler', 1);
      push(eh[2], a.z - dir * 5.0, 'handler', 2);
      /**
       * The row stays CONNECTED TO THE DISC. Pinned to an absolute depth it sat
       * 26.4 m ahead of the disc at the exact moment the endzone call fired —
       * two disconnected knots of people with the whole middle of the field
       * empty between them, which is the shape the comment above was written to
       * avoid and did not. Moving the row forward off the back line fixed half
       * of it; making it disc-relative fixes the rest, and it tightens smoothly
       * as the disc advances instead of snapping.
       */
      const ez = dir * clamp(dir * a.z + 12,
        FIELD.goalLine + 3, FIELD.goalLine + FIELD.endzoneDepth * 0.55);
      const xs = [-11, -4, 4, 11];
      for (let i = 0; i < 4; i++) push(xs[i], ez, 'cutter', i);
      break;
    }
  }
  return out;
}

export function handlerCount(name: FormationName): number {
  return name === 'horizontal' || name === 'endzone' ? 3 : 2;
}

/** Situational formation call. `prefer` is the team's base look. */
export function chooseFormation(
  disc: Vec2, dir: AttackDir, prefer: FormationName, windSpeed: number, openSign: Sign,
): FormationName {
  // The endzone set is a real look but it is not a column, so it is worth
  // asking for it only when it is genuinely an endzone situation. At 22 m it
  // was firing from a third of the way up the field and the stack — the shape
  // the sport is read by — was on screen far less than it should have been.
  // 13, not 17: the row is disc-relative now, and firing the call later keeps
  // the set connected — at 17 the cutters were 26 m ahead of the disc the
  // instant it fired.
  if (yardsToGoal(disc.z, dir) <= 13) return 'endzone';
  /**
   * The side stack is called when the disc is genuinely trapped on a line. At
   * 11.5 m it was firing on a third of possessions, and every call moved the
   * whole column across the field — the shape changed more often than the
   * disc did.
   *
   * IT ALSO HAS TO KNOW WHICH LINE. A side stack works by putting the column on
   * one sideline and isolating everything on the other side of it, and
   * `stackColumnX` builds it at `-openSign * 12.5` — the break sideline. That
   * is right when the disc is trapped on the break side: the column stands on
   * the line the disc is already stuck to, and the isolated open side is the
   * other 30 m of field.
   *
   * On the OPEN sideline it is the same call and the opposite shape. The disc
   * sits at x = +16 with the open side also at +X — the trap, which is exactly
   * what `force sideline` is for — and the column goes to x = -12.5, isolating
   * a strip six metres wide between the disc and the paint. The offence
   * "isolates" a corridor no cutter can turn around in, against the one force
   * in the sport designed to put it there.
   *
   * So the trigger asks for both: near a line, AND the open side pointing back
   * into the field. Trapped on the open side you do not isolate anything; you
   * work the reset and swing it, which is what the base look already does.
   */
  if (Math.abs(disc.x) > 14.0 && disc.x * openSign < 0) return 'side';
  if (windSpeed > 7.5) return 'vertical';
  return prefer === 'endzone' ? 'vertical' : prefer;
}

/* -------------------------------------------------------------------- cuts */

export interface CutRoute {
  kind: CutKind;
  lane: LaneKey;
  /** Where the setup step goes — deliberately the WRONG way, to sell the cut. */
  setup: Vec2;
  /** Where the cut attacks after the plant. */
  target: Vec2;
  /** Which side of the field this cut is committed to. */
  side: Sign;
  setupTime: number;
  maxTime: number;
}

/** Classify a point into the lane it occupies, relative to the disc. */
export function laneOf(
  x: number, z: number, disc: Vec2, dir: AttackDir, openSign: Sign,
): LaneKey {
  const downfield = dir * (z - disc.z);
  const side: 'open' | 'break' = (x - disc.x) * openSign >= 0 ? 'open' : 'break';
  if (downfield < 1.5) return side === 'open' ? 'reset-open' : 'reset-break';
  return `${side}-${downfield < 16 ? 'under' : 'deep'}` as LaneKey;
}

/**
 * Build a committed cut: a setup step away from where you are going, a plant,
 * and a hard change of direction into the target. `j` is a deterministic
 * jitter in [0,1] so cuts are not identical.
 */
export function buildCut(
  kind: CutKind, from: Vec2, disc: Vec2, dir: AttackDir, openSign: Sign,
  side: Sign, j: number,
): CutRoute {
  const brk = -openSign as Sign;
  let setup: Vec2;
  let target: Vec2;
  let maxTime: number = PLAY.underCutTime;

  switch (kind) {
    case 'under':
      // Sell deep first, then come back to the disc on the open side.
      setup = { x: from.x + side * 1.2, z: from.z + dir * 3.0 };
      target = { x: disc.x + side * (6 + 3 * j), z: disc.z + dir * (5.5 + 4 * j) };
      break;
    case 'break-under':
      setup = { x: from.x + brk * 0.8, z: from.z + dir * 2.6 };
      target = { x: disc.x + brk * (7 + 3 * j), z: disc.z + dir * (3 + 2.5 * j) };
      break;
    case 'deep': {
      // Sell the under first, plant, and attack the space behind.
      //
      // A DEEP CUT ATTACKS THE SPACE BEHIND THE DEEPEST DEFENDER, which is
      // behind the CUTTER — not a fixed offset from the disc. Measured only
      // from the disc it resolved behind the feet of the man it was handed to:
      // `deep` is offered to the back of the stack, who already stands 23-28 m
      // downfield, so a target at disc + 24 m asked him to jog 4 m forward, or
      // at slot 4 to run 3.8 m BACKWARDS. The huck — the most spectacular thing
      // in the sport — was structurally impossible; only 3 of 73 throws in a
      // match gained over 20 m, all of them desperation at stall 8.8.
      setup = { x: from.x - side * 1.0, z: from.z - dir * 2.8 };
      const ahead = dir * (from.z - disc.z);
      const reach = Math.min(38, Math.max(24 + 8 * j, ahead + 13 + 6 * j));
      target = { x: disc.x + side * (4 + 5 * j), z: disc.z + dir * reach };
      maxTime = PLAY.deepCutTime;
      break;
    }
    case 'strike':
      setup = { x: from.x - side * 1.6, z: from.z + dir * 1.2 };
      target = { x: disc.x + side * (4 + 3 * j), z: dir * (FIELD.goalLine + 2 + 4 * j) };
      maxTime = 1.8;
      break;
    case 'up-line':
      setup = { x: from.x - openSign * 1.6, z: from.z - dir * 1.0 };
      target = { x: disc.x + openSign * (2.0 + 1.5 * j), z: disc.z + dir * (5 + 2 * j) };
      maxTime = 1.6;
      break;
    case 'dump':
      // A reset goes to the OPEN side and behind. Throwing the reset through
      // the mark is the single most punished decision in the sport.
      //
      // It also has to MOVE. The reset already stands behind the disc on the
      // open side, so a two-metre shuffle to a target he is practically
      // standing on generates no separation and dies on the arrival test the
      // moment it starts. The setup sells the up-line hard the other way, then
      // he breaks back into the reset space with a real change of direction.
      setup = { x: from.x + brk * 2.4, z: from.z + dir * 2.8 };
      target = {
        x: clamp(disc.x + openSign * (6.5 + 2.5 * j), -RESET_BAND - 2, RESET_BAND + 2),
        z: disc.z - dir * (7.5 + 2 * j),
      };
      maxTime = 2.0;
      break;
    case 'swing':
      setup = { x: from.x - openSign * 1.4, z: from.z - dir * 1.2 };
      target = {
        x: clamp(disc.x + openSign * (8 + 2 * j), -SWING_BAND, SWING_BAND),
        z: disc.z - dir * (2 + 2 * j),
      };
      maxTime = 1.8;
      break;
  }

  /**
   * A RESET NEVER RUNS BEHIND YOUR OWN GOAL LINE — the same rule the backfield
   * stations obey, applied to the cut that actually gets run.
   *
   * Flooring `formationStations` was half a fix. It parks both handlers level
   * with a pinned disc correctly, and then `buildCut` sends one of them
   * backwards over the line anyway: with the disc on its own goal line at
   * z = -30, the dump target resolved to z = -38.5, six and a half metres deep
   * in the offence's own endzone. `clampToField` does not catch it because the
   * end line is at 50, not 32.
   *
   * The ground the floor takes away comes back as WIDTH, which is the real
   * answer rather than a clamp: pinned deep, handlers swing across the field
   * instead of dumping backwards, and the cut flattens into the swing it should
   * have been.
   */
  if (kind === 'dump' || kind === 'swing') {
    const floor = -dir * (FIELD.goalLine - PIN_MARGIN);
    const rawZ = target.z;
    target.z = dir > 0 ? Math.max(rawZ, floor) : Math.min(rawZ, floor);
    const lost = Math.abs(rawZ - target.z);
    if (lost > 0.1) {
      const away = (Math.sign(target.x - disc.x) || openSign) as Sign;
      target.x = clamp(target.x + away * lost * 0.8, -SWING_BAND, SWING_BAND);
    }
  }

  const t = clampToField(target);
  return {
    kind,
    lane: laneOf(t.x, t.z, disc, dir, openSign),
    setup: clampToField(setup),
    target: t,
    side,
    setupTime: kind === 'strike' || kind === 'up-line' ? PLAY.setupTime * 0.7 : PLAY.setupTime,
    maxTime,
  };
}

/* -------------------------------------------------------------------- mark */

/**
 * Where the marker stands: inside the stall radius, angled to the break side
 * and a touch downfield so his body is in the break-throw release window.
 */
export function markPoint(
  thrower: Vec2, dir: AttackDir, breakSign: Sign, distance: number = PLAY.markDistance,
): Vec2 {
  const dx = breakSign * 0.90;
  const dz = dir * 0.44;
  const l = Math.hypot(dx, dz);
  return { x: thrower.x + (dx / l) * distance, z: thrower.z + (dz / l) * distance };
}

/* -------------------------------------------------------------------- zone */

export type ZoneRole =
  | 'cup-mark' | 'cup-left' | 'cup-right'
  | 'wing-open' | 'wing-break'
  | 'short-deep' | 'deep';

export interface ZoneStation { role: ZoneRole; x: number; z: number }

/**
 * A 3-2-2 zone: three-person cup on the disc, two wings, a short deep and a
 * deep. Positions are anchored to the disc, which is what makes a zone read as
 * a zone — the shell slides with the swing rather than chasing bodies.
 */
export function zoneStations(
  disc: Vec2, dir: AttackDir, openSign: Sign, deepThreat: Vec2 | null,
): ZoneStation[] {
  const brk = -openSign as Sign;
  const m = markPoint(disc, dir, brk, PLAY.markDistance);
  const cupR = 4.4;
  const deepX = deepThreat ? clamp(deepThreat.x * 0.55, -9, 9) : 0;
  let deepZ = disc.z + dir * 26;
  if (dir * deepZ > FIELD.goalLine + 5) deepZ = dir * (FIELD.goalLine + 5);

  const raw: ZoneStation[] = [
    { role: 'cup-mark', x: m.x, z: m.z },
    { role: 'cup-left', x: disc.x - cupR * 0.88, z: disc.z + dir * cupR * 0.6 },
    { role: 'cup-right', x: disc.x + cupR * 0.88, z: disc.z + dir * cupR * 0.6 },
    { role: 'wing-open', x: disc.x + openSign * 10.5, z: disc.z + dir * 7.5 },
    { role: 'wing-break', x: disc.x + brk * 10.5, z: disc.z + dir * 7.5 },
    { role: 'short-deep', x: disc.x * 0.4, z: disc.z + dir * 15 },
    { role: 'deep', x: deepX, z: deepZ },
  ];
  return raw.map((s) => {
    const p = clampToField({ x: s.x, z: s.z });
    return { role: s.role, x: p.x, z: p.z };
  });
}

/**
 * Should the defence call zone? Wind is the classic trigger; a big late lead is
 * the other one (slow the game down, make them work).
 */
export function shouldPlayZone(
  windSpeed: number, scoreDiff: number, pointsPlayed: number, bias: number,
): boolean {
  const windPull = smoothstep(4.5, 11, windSpeed);
  const leadPull = scoreDiff >= 3 && pointsPlayed > 6 ? 0.35 : 0;
  return windPull + leadPull + bias > 0.5;
}

/* --------------------------------------------------------------------- rng */

/**
 * Bit-identical mirror of `core/Ctx.ts`'s `Rng` (xorshift128). It exists only so
 * the sim can run headless in Node without importing the engine (and therefore
 * three.js). Anything holding a real `ctx.rand` can be passed wherever a
 * `RandomSource` is expected — the shapes match structurally.
 */
export interface RandomSource {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  gauss(): number;
  fork(salt: number): RandomSource;
}

export class SeededRng implements RandomSource {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed = 0x9e3779b9) {
    this.a = seed >>> 0; this.b = (seed ^ 0x85ebca6b) >>> 0;
    this.c = (seed ^ 0xc2b2ae35) >>> 0; this.d = (seed ^ 0x27d4eb2f) >>> 0;
    for (let i = 0; i < 16; i++) this.next();
  }
  next(): number {
    let t = this.d;
    const s = this.a;
    this.d = this.c; this.c = this.b; this.b = s;
    t ^= t << 11; t ^= t >>> 8;
    this.a = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.a / 4294967296;
  }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hi: number): number { return Math.floor(this.range(lo, hi + 1)); }
  gauss(): number {
    const u = Math.max(1e-7, this.next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  fork(salt: number): SeededRng { return new SeededRng((this.a ^ (salt * 0x9e3779b9)) >>> 0); }
}
