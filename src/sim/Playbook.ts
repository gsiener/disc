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

/** The call the defence makes. `straight` = straight-up mark (no side taken). */
export type Force = 'forehand' | 'backhand' | 'straight';

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
  /** A cut is abandoned after this long. */
  underCutTime: 2.2,
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
  const forehandX = handSideSign('right', dir);
  return force === 'forehand' ? forehandX : (-forehandX as Sign);
}

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
  const push = (x: number, z: number, role: 'handler' | 'cutter', depth: number): void => {
    const p = clampToField({ x, z });
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
      const vhx = clamp(a.x, -(FIELD.halfWidth - 6.0), FIELD.halfWidth - 6.0);
      push(clamp(vhx + openSign * 4.5, -RESET_BAND, RESET_BAND), a.z - dir * 6.5, 'handler', 0);
      push(clamp(vhx + brk * 6.5, -SWING_BAND, SWING_BAND), a.z - dir * 3.5, 'handler', 1);
      const sx = stackColumnX('vertical', a, openSign);
      for (let i = 0; i < 5; i++) {
        push(sx, a.z + dir * (PLAY.stackLead + PLAY.stackSpacing * i), 'cutter', i);
      }
      break;
    }
    case 'horizontal': {
      // 3 handlers behind, 4 cutters spread the full width 15 m downfield.
      // The handler row is centred on a *clamped* anchor so the outside
      // stations cannot collapse onto each other against a sideline.
      const hx = clamp(a.x, -(FIELD.halfWidth - 8.5), FIELD.halfWidth - 8.5);
      push(hx + brk * 7.0, a.z - dir * 5.5, 'handler', 0);
      push(hx, a.z - dir * 4.0, 'handler', 1);
      push(hx + openSign * 7.0, a.z - dir * 5.5, 'handler', 2);
      const xs = [-13.5, -4.5, 4.5, 13.5];
      for (let i = 0; i < 4; i++) push(xs[i], a.z + dir * 15, 'cutter', i);
      break;
    }
    case 'side': {
      // 5 cutters stacked on the break sideline, isolating the whole open side.
      const shx = clamp(a.x, -(FIELD.halfWidth - 5.5), FIELD.halfWidth - 5.5);
      push(clamp(shx + openSign * 4.0, -RESET_BAND, RESET_BAND), a.z - dir * 6.5, 'handler', 0);
      push(clamp(shx + brk * 6.0, -SWING_BAND, SWING_BAND), a.z - dir * 3.0, 'handler', 1);
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
      const ehx = clamp(a.x, -(FIELD.halfWidth - 8.0), FIELD.halfWidth - 8.0);
      push(clamp(ehx + openSign * 6.5, -RESET_BAND, RESET_BAND), a.z - dir * 5.0, 'handler', 0);
      push(ehx, a.z - dir * 6.5, 'handler', 1);
      push(clamp(ehx + brk * 6.5, -SWING_BAND, SWING_BAND), a.z - dir * 5.0, 'handler', 2);
      const ez = dir * (FIELD.goalLine + FIELD.endzoneDepth * 0.52);
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
  disc: Vec2, dir: AttackDir, prefer: FormationName, windSpeed: number,
): FormationName {
  // The endzone set is a real look but it is not a column, so it is worth
  // asking for it only when it is genuinely an endzone situation. At 22 m it
  // was firing from a third of the way up the field and the stack — the shape
  // the sport is read by — was on screen far less than it should have been.
  if (yardsToGoal(disc.z, dir) <= 17) return 'endzone';
  // The side stack is called when the disc is genuinely trapped on a line. At
  // 11.5 m it was firing on a third of possessions, and every call moved the
  // whole column across the field — the shape changed more often than the
  // disc did.
  if (Math.abs(disc.x) > 14.0) return 'side';
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
    case 'deep':
      // Sell the under first, plant, and attack the space behind.
      setup = { x: from.x - side * 1.0, z: from.z - dir * 2.8 };
      target = { x: disc.x + side * (4 + 5 * j), z: disc.z + dir * (24 + 8 * j) };
      maxTime = PLAY.deepCutTime;
      break;
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
