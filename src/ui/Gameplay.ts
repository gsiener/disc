/**
 * The gameplay layer: everything anchored to the world rather than to the
 * frame, plus the throw meter.
 *
 * ## What this layer is for
 *
 * A viewer looking at ONE STILL FRAME of a point must be able to say: who is on
 * offence, who has the disc, which way the force is set, who is cutting and into
 * what space, who the reset is, and how close the count is to running out.
 * Ultimate reads as **stack, force, cutter lanes and dump resets** the way
 * football reads as lines and width, and none of those four survive being
 * photographed: a stack is only a stack if you know the five bodies in a line
 * belong to each other, a force is a rule one defender is imposing with their
 * hips, a cut is a *velocity* and a still frame has no velocities in it, and the
 * count is a number nobody is saying out loud.
 *
 * So the test every mark here has to pass is not "is it true" but *"is it
 * invisible in a photograph of the play"*. Bodies are not annotated; structure,
 * intent and time are.
 *
 * ## The marks
 *
 *   stack spine    the column, drawn as a line through the bodies that hold it,
 *                  rungs on the members, an arrow on the attacking end. The
 *                  central structure of the sport and nothing drew it before.
 *   force fence    the closed shoulder as a toothed barrier, not a bare arc
 *   cutter lanes   the one or two runners actually going somewhere, as ground
 *                  vectors — the only mark here that shows time
 *   reset + count  who the bail-out is, and how much of the stall is spent
 *   landing ring   where the disc comes down, plus a collapsing ring for *when*
 *   cut ghost      the order you gave, dashed, so you can judge the execution
 *   control ring   the athlete you are driving; dashed outer ring on defence
 *   carrier pip    who physically holds the disc
 *   receiver / switch preview — a selection, and the body a held switch takes
 *
 * ## Two rules that make it survive the tele
 *
 * **Everything is cased.** The broadcast camera sits 45 m out at a 22–30° lens;
 * a player is 35 px tall and every mark here is a hairline. Measured on live
 * frames before this pass, the whole layer was drawing between 1.0 and 1.7
 * device pixels of 60 %-alpha near-white — which is legible over a shadowed
 * patch of turf and completely gone over a sunlit one, and the frames proved it.
 * So every stroke is drawn twice: a dark casing 2.3 px wider underneath, then
 * the light core. That is the cartographic road-casing trick and it is the only
 * thing that makes a 2 px light line hold its value against *both* ends of the
 * turf's range. It costs one extra `d` write per mark per frame.
 *
 * **Weight has a floor.** The old scale was `w / 1920` clamped at 0.72, so every
 * stroke got *thinner* the smaller the window — exactly backwards, since a
 * smaller frame is where a hairline dies first. It is now `w / 1700` clamped to
 * [0.95, 1.45]: never below nominal, and heavier on a big panel.
 *
 * ## Saturation, and the conflict with the art direction
 *
 * `docs/art-direction.md` reserves saturation for the two kits and the disc —
 * everything else under 50 % HSV. This layer sits on top of all three and the
 * rule is right, so it is obeyed: every structural mark is near-white with a
 * near-black casing, and contrast comes from *weight, casing and completeness*
 * rather than hue. Two marks are allowed a tint and both are capped at S ≤ 50 %:
 * the stall count arc past seven, and the stamina ring when the tank is low.
 * Those two encode "you are about to lose something", which is the one message
 * that may not wait for the viewer to parse a shape. Note the previous version
 * of this file broke the rule harder and silently — the stamina ring ran
 * `rgba(255,171,61)` (S = 76 %) and `rgba(255,95,69)` (S = 73 %) for most of a
 * real point. Those are now 49 % and 47 %.
 *
 * The world-anchored shapes are true projections, not billboards: a ground ring
 * is 40 world points run through the camera and joined, so it sits on the turf
 * in perspective and foreshortens correctly. The flight arc is sampled from
 * `DiscPhysics` through the disc system's own `predictPath`, so it is the
 * trajectory the disc will actually fly.
 */

import * as THREE from 'three';

import type { Ctx } from '../core/Ctx.ts';
import {
  Clip, Motion, PathBuilder, clamp, clamp01, easeOut, el,
  setAttr, setShown, setStyle, setText, svgEl,
} from './Dom.ts';
import type { HudFrame, HudSource, HudWidget, TeamBrand } from './Model.ts';

const RING_SEGMENTS = 40;
const _v = new THREE.Vector3();

/* --------------------------------------------------------------- constants */

/** Radius of the ring under the controlled player, metres. */
const RING_R = 0.62;
/** The dashed outer ring that says "defending". Never a colour change. */
const DEFENCE_RING_R = 1.05;

/**
 * The force: a hatched fence across the closed shoulder.
 *
 * It was a 130° arc at 1.1 m and that failed twice over, both failures visible
 * in `shots/legib-before` and `shots/legib-after` respectively.
 *
 * First, curvature does not survive the tele. Measured on live frames, the old
 * arc projected to roughly 60 × 12 px, and to 60 × 7 px whenever the break
 * bearing happened to lie along the camera axis — a slightly bent line in the
 * grass, indistinguishable from a mow mark. Perspective takes curvature away
 * from a ground shape before it takes anything else, and no radius buys it back.
 *
 * Second, and worse: an arc is the *same visual word* as every other mark in
 * this layer. The control ring, the switch ghost, the landing ring and the reset
 * gauge are all circles on the turf. Pushing the arc out to 1.45 m to clear them
 * did not help — at a 20° camera elevation the X axis is compressed to about a
 * third, so a 1.45 m ring is barely twice the screen width of a 0.62 m one, and
 * the first after-frame showed the force and the control ring reading as one
 * knot of overlapping ellipses under the thrower.
 *
 * So it is a straight barrier now: a 3.4 m fence set 1.35 m off the closed
 * shoulder, with five teeth pointing back at the thrower. That is the
 * cartographic scarp symbol, and it is right for three separate reasons — a
 * straight line has no curvature to lose; its long axis is perpendicular to the
 * break bearing, so when the force is set to a sideline (which is nearly always)
 * the fence runs along Z and lands broadside to the camera; and a toothed
 * straight line is not a circle, so it can never be confused with anything else
 * this layer draws. The teeth carry the direction: the protected side is the
 * side they point at.
 */
const FORCE_OFF = 1.35;
const FORCE_LEN = 1.45;
const FORCE_TOOTH = 0.68;
const FORCE_TEETH = 5;
/** A shallow bow toward the thrower, so the fence wraps rather than slices. */
const FORCE_BOW = 0.22;

/**
 * The stack.
 *
 * Fitted, not assumed: a total-least-squares axis through the offence minus the
 * thrower, one rejection pass at 3.6 m, then a refit. It is drawn only when the
 * survivors genuinely form a column — four or more of them, at least 7 m long,
 * under 3.0 m of lateral scatter, and within 60° of the field's long axis. On
 * the sampled point the offence held |axis·Z| ≥ 0.96 with 0.6–2.5 m of scatter
 * over 9–30 m for most of every possession, which is a real, drawable structure;
 * on the two frames where it broke up (scatter 4.0–4.4 m, cutters gone) these
 * gates drop the mark rather than draw a line through a scatter of bodies and
 * call it a stack. A mark that lies about structure is worse than no mark.
 */
const STACK_REJECT = 3.6;
const STACK_MIN_MEMBERS = 4;
const STACK_MIN_SPAN = 7;
const STACK_MAX_RMS = 3.0;
/**
 * Half-length of the rung drawn across the spine at each member, and the barb
 * on the downfield arrowhead.
 *
 * Both were bigger and both were wrong on the first after-frames. At 1.05 m the
 * rungs read as crosses laid on the grass rather than ticks on a line; at 1.75 m
 * the arrowhead's barbs carry a large Z component, project long, and came out
 * *wider than an athlete is tall* — a kite at the end of the spine instead of a
 * direction. Perspective is not uniform here: a mark's Z extent survives and its
 * X extent does not, so anything with a Z component has to be sized against the
 * screen, not against the field.
 */
const STACK_RUNG = 0.8;
const STACK_HEAD = 1.0;
/** How far past the end bodies the spine runs, so it reads as a line not a join. */
const STACK_OVERSHOOT = 1.2;

/**
 * Cutter lanes.
 *
 * The only mark in the layer that annotates *time*, which is the whole reason it
 * earns its ink: a still frame contains no velocities, so "who is cutting and
 * into what space" is strictly unrecoverable from the pixels. Velocity is
 * differenced here rather than asked for, because `HudPlayer` does not carry it
 * and `Model.ts` is not this file's to change; a quarter-second EMA over the
 * frame delta is stable enough at 120 Hz and costs two floats per athlete.
 *
 * Capped at two runners and gated at 4.0 m/s so it marks committed cuts rather
 * than everyone jogging into shape. Offence only — a defender's run is not a
 * structure the viewer is being asked to read.
 */
const LANE_SPEED = 3.9;
const LANE_FULL = 5.2;
const LANE_LEAD = 1.15;
const LANE_MAX = 2;
const LANE_MIN_LEN = 2.6;
const LANE_MAX_LEN = 13;
/** EMA rate on differenced velocity, s⁻¹. τ ≈ 0.25 s. */
const VEL_RATE = 4;

/** Seconds the force mark survives a dropped read before it fades. */
const FORCE_HOLD = 0.85;

/**
 * The reset, and the count.
 *
 * `Hud.ts` publishes `dumpId` only from stall 7, which is correct for "the panic
 * button is now aimed" but two seconds too late for "you should be looking at
 * him". The same rule (nearest available handler behind the disc, cutters priced
 * at 1.7×) is re-run here from stall 4 so the mark fades up as the count climbs;
 * from 7 the published id wins, so the mark can never disagree with the throw
 * the game would actually make.
 */
const RESET_FROM = 4;
/**
 * Gauge radius, and where its end caps turn in to.
 *
 * 1.30 m was too big: on the after-frames it came out 89 px across, wider than
 * an athlete is tall, and in a cluster it floated between four bodies without
 * attaching to any of them. A ground mark's only claim on a body is proximity,
 * so a gauge that has to identify one player inside a knot has to hug his feet.
 */
const COUNT_R = 0.88;
const RESET_R = 0.56;

/** Landing ring, and the collapsing ring that says *when*. */
const LAND_R = 1.0;
const ARRIVE_LEAD = 1.7;
const ARRIVE_GAIN = 4.6;

/** Seconds a released cut order stays on the turf before it is gone. */
const CUT_FADE = 1.5;
/** Turnover pulse: 1.4× radius, 0.3 s. */
const PULSE_TIME = 0.3;
const PULSE_GAIN = 0.4;

/** Highest player id probed. The roster is 14; 32 is headroom at 32 map gets. */
const MAX_ID = 32;

/* ------------------------------------------------------------------ palette */

/**
 * The casing. Near-black at just over half alpha: dark enough to hold a light
 * core against sunlit turf, transparent enough that it never reads as a second
 * line of its own over shadow.
 */
const CASE_INK = 'rgba(6,12,9,.55)';
/** Extra width the casing carries, in CSS px. Deliberately unscaled — this is a
 *  pixel-contrast device, not a piece of geometry. */
const CASE_W = 2.3;

const INK_STRUCTURE = 'rgba(210,228,248,.66)';
const INK_FORCE = 'rgba(238,247,255,.95)';
const INK_LANE = 'rgba(212,232,252,.86)';
const INK_CUT = 'rgba(198,219,244,.82)';
const INK_FLIGHT = 'rgba(246,250,255,.86)';
const INK_LAND = 'rgba(248,252,255,.88)';
const INK_ARRIVE = 'rgba(240,248,255,.44)';
const INK_RESET = 'rgba(216,236,228,.74)';
const INK_COUNT = 'rgba(234,244,255,.88)';
/** S = 50 %. The one deliberate tint, and only past stall seven. */
const INK_COUNT_HOT = 'rgba(240,186,120,.96)';
const INK_RING = 'rgba(236,245,255,.95)';
/** S = 49 % / 47 %. Were 76 % / 73 %; see the header. */
const INK_STAM_LOW = 'rgba(240,178,122,.95)';
const INK_STAM_CRIT = 'rgba(232,142,124,.95)';
const INK_RECV = 'rgba(139,236,190,.90)';
const INK_RECV_AUTO = 'rgba(139,236,190,.68)';
/** S = 43 %, and it stands for the one object that is allowed to be saturated. */
const INK_DISC = 'rgba(246,214,140,.95)';

/* ------------------------------------------------------------------ helpers */

/** Screen-space projection of a world point, in CSS pixels. */
class Projector {
  x = 0;
  y = 0;
  ok = false;

  constructor(private ctx: Ctx) {}

  at(x: number, y: number, z: number): boolean {
    const cam = this.ctx.camera;
    _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    if (_v.z > -0.08) { this.ok = false; return false; }
    _v.applyMatrix4(cam.projectionMatrix);
    this.x = (_v.x * 0.5 + 0.5) * this.ctx.width;
    this.y = (-_v.y * 0.5 + 0.5) * this.ctx.height;
    this.ok = Math.abs(this.x) < 12000 && Math.abs(this.y) < 12000;
    return this.ok;
  }
}

/**
 * One cased stroke: a dark path and a light path carrying identical geometry.
 *
 * Both are children of the same parent and the casing is created first, so
 * document order does the compositing. Marks that would overlap each other are
 * built as a *single* `Mark` with several subpaths in one `d` — otherwise the
 * second mark's casing would notch the first mark's core, which is what makes
 * the force fence's teeth look like they are cutting the rail rather than growing
 * out of it.
 */
class Mark {
  private under: SVGPathElement;
  private over: SVGPathElement;

  constructor(
    parent: SVGElement, colour: string,
    cap: 'round' | 'butt' | 'square' = 'round',
    private caseW = CASE_W,
  ) {
    this.under = svgEl('path', undefined, parent);
    this.over = svgEl('path', undefined, parent);
    for (const n of [this.under, this.over]) {
      setAttr(n, 'fill', 'none');
      setAttr(n, 'stroke-linejoin', 'round');
      setAttr(n, 'stroke-linecap', cap);
    }
    setAttr(this.under, 'stroke', CASE_INK);
    setAttr(this.over, 'stroke', colour);
  }

  /** Geometry plus core width; the casing tracks it. */
  set(d: string, width: number): void {
    setAttr(this.under, 'd', d);
    setAttr(this.over, 'd', d);
    setAttr(this.under, 'stroke-width', (width + this.caseW).toFixed(2));
    setAttr(this.over, 'stroke-width', width.toFixed(2));
  }

  clear(): void {
    setAttr(this.under, 'd', '');
    setAttr(this.over, 'd', '');
  }

  colour(c: string): void { setAttr(this.over, 'stroke', c); }

  /** Dash the core only — a dashed casing would strobe under the gaps. */
  dash(pattern: string): void {
    setAttr(this.over, 'stroke-dasharray', pattern);
    setAttr(this.under, 'stroke-dasharray', pattern);
  }

  opacity(v: number): void {
    const s = v.toFixed(3);
    setStyle(this.under, 'opacity', s);
    setStyle(this.over, 'opacity', s);
  }
}

/* -------------------------------------------------------------------- layer */

export class GameplayLayer implements HudWidget {
  readonly svg: SVGSVGElement;
  readonly meter: HTMLElement;

  private ctx: Ctx;
  private src: HudSource;
  private brands: [TeamBrand, TeamBrand];
  private proj: Projector;

  /* world gizmos, back to front */
  private gStack: SVGGElement;
  private stack: Mark;
  private gForce: SVGGElement;
  private force: Mark;
  private gLane: SVGGElement;
  private lane: Mark;
  private laneHead: Mark;
  private gCut: SVGGElement;
  private cut: Mark;
  private gFlight: SVGGElement;
  private flight: Mark;
  private landMark: Mark;
  private arrive: Mark;
  private gReset: SVGGElement;
  private resetRing: Mark;
  private countArc: Mark;
  private gGhost: SVGGElement;
  private ghostRing: Mark;
  private gRing: SVGGElement;
  private ringOuter: Mark;
  private ringTrack: Mark;
  private ringFill: SVGPathElement;
  private ringChevron: SVGPathElement;
  private ringChevronCase: SVGPathElement;
  private gCarrier: SVGGElement;
  private carrierStem: Mark;
  private carrierDisc: SVGEllipseElement;
  private gRecv: SVGGElement;
  private recvBrackets: Mark;

  /* meter */
  private mType: HTMLElement;
  private mQual: HTMLElement;
  private mBand: HTMLElement;
  private mFill: HTMLElement;
  private mHead: HTMLElement;
  private mPower: HTMLElement;
  private mCaret!: HTMLElement;

  private pb = new PathBuilder();
  private pb2 = new PathBuilder();
  private pb3 = new PathBuilder();
  private scale = 1;
  private power = new Motion(0, 26);
  private quality = new Motion(0, 18);
  private meterIn = new Motion(0, 9);
  private stamina = new Motion(1, 6);

  /* off-ball legibility */
  private forceIn = new Motion(0, 9);
  /**
   * The break bearing, unwrapped. A flipped force is a 180° change and it has
   * to *sweep*, not cut: a pop between two arcs is easy to miss in peripheral
   * vision, and sweeping the arc across the thrower is the same gesture a
   * marker makes when they change the call.
   */
  private forceAngle = new Motion(0, 11);
  private forceHas = false;
  /**
   * Sim time the force read last went stale. `Hud.readForce` drops to
   * `forceKnown = false` for a frame or two whenever the marker crosses in
   * front of the thrower (its 0.25 m deadband), and on live frames that showed
   * up as the fence blinking out and back once a second. The mark is held for
   * `FORCE_HOLD` past the last good read; a force that has genuinely gone away
   * takes the disc with it long before that.
   */
  private forceLost = -1;
  private defenceIn = new Motion(0, 8);
  private resetIn = new Motion(0, 9);
  private stackIn = new Motion(0, 7);
  private laneIn = new Motion(0, 12);
  private ghostIn = new Motion(0, 14);
  private pulse = new Clip();
  private lastFlip = -1;

  /* roster scratch — refilled every frame, never reallocated */
  private rn = 0;
  private rid = new Int32Array(MAX_ID);
  private rteam = new Int32Array(MAX_ID);
  private rx = new Float64Array(MAX_ID);
  private rz = new Float64Array(MAX_ID);
  private ry = new Float64Array(MAX_ID);
  private rhand = new Uint8Array(MAX_ID);
  private ravail = new Uint8Array(MAX_ID);

  /* differenced velocity, indexed by player id */
  private vx = new Float64Array(MAX_ID);
  private vz = new Float64Array(MAX_ID);
  private lastX = new Float64Array(MAX_ID);
  private lastZ = new Float64Array(MAX_ID);
  private hasLast = new Uint8Array(MAX_ID);

  /* fitted stack */
  private stackOk = false;
  /** True once a fit has ever been committed — the fade-out has geometry. */
  private stackHas = false;
  private sCx = 0; private sCz = 0;
  private sAx = 0; private sAz = 1;
  private sT0 = 0; private sT1 = 0;
  private sY = 0;
  private sTick = new Float64Array(MAX_ID);
  private sTickN = 0;
  private sIdx = new Int32Array(MAX_ID);

  constructor(parent: HTMLElement, ctx: Ctx, src: HudSource, brands: [TeamBrand, TeamBrand]) {
    this.ctx = ctx;
    this.src = src;
    this.brands = brands;
    this.proj = new Projector(ctx);

    this.svg = svgEl('svg', 'ug-svg', parent);
    this.svg.setAttribute('viewBox', `0 0 ${ctx.width} ${ctx.height}`);

    /* --- the stack ------------------------------------------------------- */
    // First, and dimmest. It is the floor the rest of the layer stands on: it
    // says "this column of bodies is one thing", and every brighter mark then
    // annotates something happening relative to it.
    this.gStack = svgEl('g', undefined, this.svg);
    // Thinner casing than the rest of the layer. The spine is 20–30 m long, so
    // it puts more ink on the frame than every other mark combined; at the
    // standard 2.3 px casing it came back from the first after-capture reading
    // as a white pipe laid across the pitch, competing with the athletes it is
    // supposed to be describing. 1.5 px still holds it over sunlit turf.
    this.stack = new Mark(this.gStack, INK_STRUCTURE, 'round', 1.5);
    setShown(this.gStack, false);

    /* --- the force ------------------------------------------------------- */
    this.gForce = svgEl('g', undefined, this.svg);
    this.force = new Mark(this.gForce, INK_FORCE);
    setShown(this.gForce, false);

    /* --- cutter lanes ---------------------------------------------------- */
    this.gLane = svgEl('g', undefined, this.svg);
    // Dashed, and the spine is solid. On the first after-frames a lane and the
    // spine ran near-parallel across the same patch of grass and the only thing
    // telling them apart was that one ended in an arrow — a distinction that
    // does not survive a glance. Dashing is also the honest treatment: the spine
    // is where bodies *are*, the lane is where one of them *will be*.
    this.lane = new Mark(this.gLane, INK_LANE);
    this.lane.dash('11 6');
    // The head is its own mark and solid: a 10 px barb inside a dash pattern
    // lands on or off the ink depending on where the shaft's phase happens to
    // fall, which makes the arrow flicker as the runner moves. The two only
    // touch at the tip, so the casing seam is a point.
    this.laneHead = new Mark(this.gLane, INK_LANE);
    setShown(this.gLane, false);

    /* --- commanded cut --------------------------------------------------- */
    this.gCut = svgEl('g', undefined, this.svg);
    this.cut = new Mark(this.gCut, INK_CUT);
    this.cut.dash('7 6');
    setShown(this.gCut, false);

    /* --- predicted flight ------------------------------------------------ */
    this.gFlight = svgEl('g', undefined, this.svg);
    this.flight = new Mark(this.gFlight, INK_FLIGHT);
    this.flight.dash('9 7');
    this.arrive = new Mark(this.gFlight, INK_ARRIVE);
    this.landMark = new Mark(this.gFlight, INK_LAND);
    setShown(this.gFlight, false);

    /* --- the reset, and the count ---------------------------------------- */
    this.gReset = svgEl('g', undefined, this.svg);
    this.countArc = new Mark(this.gReset, INK_COUNT, 'butt');
    this.resetRing = new Mark(this.gReset, INK_RESET, 'butt');
    setShown(this.gReset, false);

    /* --- switch preview --------------------------------------------------- */
    this.gGhost = svgEl('g', undefined, this.svg);
    this.ghostRing = new Mark(this.gGhost, INK_RING);
    this.ghostRing.dash('5 5');
    setShown(this.gGhost, false);

    /* --- controlled player ----------------------------------------------- */
    this.gRing = svgEl('g', undefined, this.svg);
    // On defence the ring gains an outer dashed circle rather than a hue: the
    // two kits and the disc own every saturated pixel in the frame, and a HUD
    // that starts colouring itself by game state takes that back one element at
    // a time. A broken outline reads as "contesting" without spending any.
    this.ringOuter = new Mark(this.gRing, 'rgba(224,238,255,.62)');
    this.ringOuter.dash('4 6');
    this.ringTrack = new Mark(this.gRing, 'rgba(232,242,255,.26)');
    // The stamina fill rides on the track's casing rather than carrying its own:
    // they are the same circle, and a second casing would darken the track it
    // sits on.
    this.ringFill = svgEl('path', undefined, this.gRing);
    setAttr(this.ringFill, 'fill', 'none');
    setAttr(this.ringFill, 'stroke', INK_RING);
    setAttr(this.ringFill, 'stroke-linecap', 'round');
    this.ringChevronCase = svgEl('path', undefined, this.gRing);
    this.ringChevron = svgEl('path', undefined, this.gRing);
    setAttr(this.ringChevronCase, 'fill', 'none');
    setAttr(this.ringChevronCase, 'stroke', 'rgba(6,12,9,.6)');
    setAttr(this.ringChevronCase, 'stroke-width', '3.4');
    setAttr(this.ringChevronCase, 'stroke-linejoin', 'round');
    setAttr(this.ringChevron, 'fill', 'rgba(242,249,255,.96)');
    setAttr(this.ringChevron, 'stroke', 'none');
    setShown(this.gRing, false);

    /* --- carrier --------------------------------------------------------- */
    this.gCarrier = svgEl('g', undefined, this.svg);
    this.carrierStem = new Mark(this.gCarrier, 'rgba(246,214,140,.55)');
    this.carrierDisc = svgEl('ellipse', undefined, this.gCarrier);
    setAttr(this.carrierDisc, 'fill', INK_DISC);
    setAttr(this.carrierDisc, 'stroke', 'rgba(14,18,10,.62)');
    setAttr(this.carrierDisc, 'stroke-width', '1.4');
    setShown(this.gCarrier, false);

    /* --- receiver -------------------------------------------------------- */
    this.gRecv = svgEl('g', undefined, this.svg);
    this.recvBrackets = new Mark(this.gRecv, INK_RECV, 'square');
    setShown(this.gRecv, false);

    /* --- throw meter ------------------------------------------------------ */
    this.meter = el('div', 'ug-panel ug-meter', parent);
    const hd = el('div', 'hd', this.meter);
    this.mType = el('span', 'ty', hd);
    this.mQual = el('span', 'q', hd);
    const gut = el('div', 'gut', this.meter);
    this.mCaret = el('i', 'caret', gut);
    const tw = el('div', 'tw', this.meter);
    const track = el('div', 'track', tw);
    this.mBand = el('div', 'band', track);
    this.mFill = el('div', 'fill', track);
    this.mHead = el('div', 'head', tw);
    const ft = el('div', 'ft', this.meter);
    el('span', 'k', ft).textContent = 'Power';
    this.mPower = el('span', 'v', ft);
    setShown(this.meter, false);
  }

  resize(w: number, h: number): void {
    setAttr(this.svg, 'viewBox', `0 0 ${w} ${h}`);
    // Never below nominal. The old `max(0.72, min(1.35, w/1920))` drew every
    // stroke at 0.72× on a 1280-wide frame — 1.0 to 1.7 device pixels for the
    // whole layer, measured — which is the resolution at which a hairline over
    // sunlit turf stops existing.
    this.scale = clamp(w / 1700, 0.95, 1.45);
  }

  restage(f: HudFrame): void {
    this.power.set(f.chargePower);
    this.quality.set(f.chargeQuality);
    this.meterIn.set(0);
    this.stamina.set(1);
    // A tableau is a still: every gizmo has to be at its settled value on the
    // first frame the shutter sees, and no clip may be mid-flight.
    this.forceIn.set(f.forceKnown ? 1 : 0);
    this.forceAngle.set(f.forceAngle);
    this.forceHas = f.forceKnown;
    this.forceLost = -1;
    this.defenceIn.set(0);
    this.resetIn.set(0);
    this.stackIn.set(0);
    this.laneIn.set(0);
    this.ghostIn.set(0);
    this.pulse.stop();
    this.lastFlip = f.flipAt;
    // Differenced velocity is meaningless across a teleport, and a stale one
    // would draw cutter lanes off bodies that were placed, not run.
    this.hasLast.fill(0);
    this.vx.fill(0);
    this.vz.fill(0);
  }

  /* ------------------------------------------------------------------ frame */

  update(f: HudFrame): void {
    this.scan(f);
    this.fitStack(f);
    this.drawStack(f);
    this.drawForce(f);
    this.drawLanes(f);
    this.drawCut(f);
    this.drawFlight(f);
    this.drawReset(f);
    this.drawSwitchPreview(f);
    this.drawControlled(f);
    this.drawCarrier(f);
    this.drawReceiver(f);
    this.drawMeter(f);
  }

  /* ----------------------------------------------------------- roster scan */

  /**
   * Pull every athlete into flat arrays and difference their velocity.
   *
   * `HudFrame` names six players by id and `HudSource` resolves one at a time;
   * neither hands over a roster, and `Model.ts` is not this file's to change. So
   * the ids are probed — a bounded 0..31 sweep of map lookups, once a frame,
   * cheaper than the ground rings it feeds. Values are copied out immediately
   * because `player()` hands back a record it reuses.
   */
  private scan(f: HudFrame): void {
    this.rn = 0;
    const dt = f.dt;
    const live = dt > 1e-4;
    for (let id = 0; id < MAX_ID; id++) {
      const p = this.src.player(id);
      if (!p) { this.hasLast[id] = 0; continue; }
      if (live) {
        if (this.hasLast[id]) {
          const k = Math.min(1, dt * VEL_RATE);
          this.vx[id] += ((p.x - this.lastX[id]) / dt - this.vx[id]) * k;
          this.vz[id] += ((p.z - this.lastZ[id]) / dt - this.vz[id]) * k;
        }
        this.lastX[id] = p.x;
        this.lastZ[id] = p.z;
        this.hasLast[id] = 1;
      }
      const i = this.rn++;
      this.rid[i] = id;
      this.rteam[i] = p.team;
      this.rx[i] = p.x;
      this.rz[i] = p.z;
      this.ry[i] = p.groundY;
      this.rhand[i] = p.position === 'Handler' ? 1 : 0;
      this.ravail[i] = p.available ? 1 : 0;
    }
  }

  /* ----------------------------------------------------------- the stack */

  /**
   * Total least squares through the offence, one rejection pass, then a refit.
   *
   * The mean-and-covariance eigenvector is the right fit here rather than a
   * least-squares-in-Z line, because a stack angled across the field is still a
   * stack and a vertical fit would blow up on it. The rejection pass is what
   * stops a single deep cutter forty metres off the front from rotating the
   * whole axis; the gates after it are what stop the mark drawing at all once
   * the shape has genuinely broken.
   */
  private fitStack(f: HudFrame): void {
    this.stackOk = false;
    const poss = f.possession;
    if (poss === null || f.discMode === 'ground') return;

    let n = 0;
    for (let i = 0; i < this.rn; i++) {
      if (this.rteam[i] !== poss) continue;
      if (this.rid[i] === f.throwerId) continue;
      this.sIdx[n++] = i;
    }
    if (n < STACK_MIN_MEMBERS) return;

    let cx = 0; let cz = 0; let ax = 0; let az = 1;
    for (let pass = 0; pass < 2; pass++) {
      cx = 0; cz = 0;
      for (let k = 0; k < n; k++) { cx += this.rx[this.sIdx[k]]; cz += this.rz[this.sIdx[k]]; }
      cx /= n; cz /= n;
      let sxx = 0; let szz = 0; let sxz = 0;
      for (let k = 0; k < n; k++) {
        const dx = this.rx[this.sIdx[k]] - cx;
        const dz = this.rz[this.sIdx[k]] - cz;
        sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
      }
      const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      ax = Math.cos(th); az = Math.sin(th);
      if (pass === 1) break;
      // Reject the bodies that have left the structure, then refit on what is
      // left. One pass is enough — a second only ever eats the stack itself.
      let m = 0;
      for (let k = 0; k < n; k++) {
        const dx = this.rx[this.sIdx[k]] - cx;
        const dz = this.rz[this.sIdx[k]] - cz;
        if (Math.abs(-dx * az + dz * ax) <= STACK_REJECT) this.sIdx[m++] = this.sIdx[k];
      }
      if (m < STACK_MIN_MEMBERS) return;
      n = m;
    }

    // Point the axis downfield so the arrowhead always lands on the attacking
    // end, and refuse a column that is not roughly field-aligned: a vertical
    // stack is a vertical stack, and drawing a spine across a spread-out
    // offence would invent a formation that is not there.
    if (az * f.attackDir < 0) { ax = -ax; az = -az; }
    if (Math.abs(az) < 0.5) return;

    // Everything below is measured into scratch first and committed in one go
    // at the bottom. A half-written fit is worse than no fit: the spine and the
    // rungs would come from different frames and the mark would draw rungs
    // hanging off a line they do not belong to.
    let t0 = Infinity; let t1 = -Infinity; let rms = 0; let y = 0;
    for (let k = 0; k < n; k++) {
      const i = this.sIdx[k];
      const dx = this.rx[i] - cx;
      const dz = this.rz[i] - cz;
      const t = dx * ax + dz * az;
      const q = -dx * az + dz * ax;
      rms += q * q;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
      this.sTick[k] = t;
      y += this.ry[i];
    }
    rms = Math.sqrt(rms / n);
    if (rms > STACK_MAX_RMS) return;
    if (t1 - t0 < STACK_MIN_SPAN) return;

    this.sTickN = n;
    this.stackHas = true;
    this.sCx = cx; this.sCz = cz;
    this.sAx = ax; this.sAz = az;
    this.sT0 = t0 - STACK_OVERSHOOT;
    this.sT1 = t1 + STACK_OVERSHOOT;
    this.sY = y / n + 0.01;
    this.stackOk = true;
  }

  /**
   * The spine, its rungs, and the arrow on the attacking end.
   *
   * All one path so the casing composites cleanly. The rungs run perpendicular
   * to the spine, which from the sideline tele is the field's X axis and is
   * therefore the foreshortened one — a ±1.05 m rung comes out around 12 px.
   * That is deliberately small: the rung's job is to say "this body is in the
   * line", and the line is doing the shouting. The arrowhead is 1.75 m barbs at
   * ±150°, which carries a large Z component and so survives the projection.
   */
  private drawStack(f: HudFrame): void {
    this.stackIn.target = this.stackOk ? 1 : 0;
    const vis = this.stackIn.step(f.dt);
    // Draw the last committed fit while it fades. Hiding on the frame the gates
    // fail makes a shape that is *breaking up* vanish instantly, which is the
    // one moment the viewer most wants to see the structure come apart.
    if (!this.stackHas || vis < 0.02) { setShown(this.gStack, false); return; }

    const { sCx: cx, sCz: cz, sAx: ax, sAz: az, sY: y } = this;
    const p = this.pb.reset();
    const px = -az; const pz = ax;

    // The spine, broken around the disc.
    //
    // Wherever the thrower stands on or near the axis — which is most of a
    // possession, since the disc is in the stack's lane — the spine ran straight
    // through the control ring, the force fence and the carrier pip, and the
    // knot frames came back as a scribble. A 2.6 m gap centred on the thrower's
    // projection puts the busiest 30 px of the frame back under the marks that
    // are about the disc, and it happens to say the true thing too: the thrower
    // is not in the stack.
    let gapLo = this.sT1; let gapHi = this.sT1;
    const th = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    if (th) {
      const dx = th.x - cx; const dz = th.z - cz;
      if (Math.abs(-dx * az + dz * ax) < 3.2) {
        const tc = clamp(dx * ax + dz * az, this.sT0, this.sT1);
        gapLo = clamp(tc - 1.3, this.sT0, this.sT1);
        gapHi = clamp(tc + 1.3, this.sT0, this.sT1);
      }
    }
    const near = this.spineRun(p, cx, cz, ax, az, y, this.sT0, gapLo);
    const far = this.spineRun(p, cx, cz, ax, az, y, gapHi, this.sT1);
    if (!near && !far) { setShown(this.gStack, false); return; }
    // A rung at every member still in the column — except the ones inside the
    // gap, which would be ticks hanging off a line that is not there.
    for (let k = 0; k < this.sTickN; k++) {
      const t = this.sTick[k];
      if (t > gapLo && t < gapHi) continue;
      const bx = cx + ax * t; const bz = cz + az * t;
      this.seg(p, bx - px * STACK_RUNG, bz - pz * STACK_RUNG,
        bx + px * STACK_RUNG, bz + pz * STACK_RUNG, y);
    }
    // Arrowhead on the attacking end of whichever run is downfield-most. When
    // the thrower is at the head of the column the far run is swallowed by the
    // gap, and putting the head at `sT1` anyway leaves an arrow floating in the
    // grass with no line attached — which is what the isolated capture showed.
    const headT = far ? this.sT1 : gapLo;
    const hx = cx + ax * headT; const hz = cz + az * headT;
    const c = Math.cos(Math.PI * 0.78); const s = Math.sin(Math.PI * 0.78);
    for (const side of [1, -1]) {
      const bx = ax * c - az * (s * side);
      const bz = ax * (s * side) + az * c;
      this.seg(p, hx, hz, hx + bx * STACK_HEAD, hz + bz * STACK_HEAD, y);
    }

    setShown(this.gStack, true);
    this.stack.set(p.build(), 1.35 * this.scale);
    setStyle(this.gStack, 'opacity', vis.toFixed(3));
  }

  /* -------------------------------------------------------------- the force */

  /**
   * A 2.9 m fence set 1.35 m off the thrower's break shoulder, teeth pointing in.
   *
   * This is the one annotation a newcomer genuinely cannot infer from watching
   * bodies. Everything else the layer marks is visible if you know where to look
   * — the stack is a column, the reset is the player standing behind the disc, a
   * cut is somebody running. The force is a *rule the defence is imposing*,
   * expressed as one defender standing four feet off one shoulder, and no amount
   * of watching recovers it.
   */
  private drawForce(f: HudFrame): void {
    if (f.forceKnown) this.forceLost = -1;
    else if (this.forceHas && this.forceLost < 0) this.forceLost = f.t;
    const stale = !f.forceKnown && (this.forceLost < 0 || f.t - this.forceLost > FORCE_HOLD);
    const thrower = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    this.forceIn.target = (!stale && thrower && f.discMode === 'held') ? 1 : 0;
    const vis = this.forceIn.step(f.dt);
    if (vis < 0.02 || !thrower) { setShown(this.gForce, false); return; }

    if (f.forceKnown) {
      // Unwrap onto the nearest branch so a flip sweeps the short way round
      // instead of unwinding through five o'clock.
      if (!this.forceHas) this.forceAngle.set(f.forceAngle);
      else {
        let d = f.forceAngle - this.forceAngle.target;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.forceAngle.target += d;
      }
      this.forceHas = true;
    }
    const a = this.forceAngle.step(f.dt);

    const y = thrower.groundY + 0.012;
    // Outward normal (toward the mark) and the fence's own axis.
    const nx = Math.sin(a); const nz = Math.cos(a);
    const tx = nz; const tz = -nx;
    const p = this.pb.reset();
    // The fence, as five segments so the shallow bow shows. Any point failing to
    // project drops the whole mark rather than leaving half a fence.
    for (let i = 0; i <= 8; i++) {
      const u = (i / 8) * 2 - 1;
      const off = FORCE_OFF - FORCE_BOW * u * u;
      const wx = thrower.x + nx * off + tx * (FORCE_LEN * u);
      const wz = thrower.z + nz * off + tz * (FORCE_LEN * u);
      if (!this.proj.at(wx, y, wz)) { setShown(this.gForce, false); return; }
      if (i === 0) p.move(this.proj.x, this.proj.y);
      else p.line(this.proj.x, this.proj.y);
    }
    // The teeth, pointing back at the thrower. This is the whole direction cue:
    // a bare line on the turf says nothing about which shoulder is shut, and a
    // toothed one says it at any size, because a comb has a face.
    for (let i = 0; i < FORCE_TEETH; i++) {
      const u = (i / (FORCE_TEETH - 1)) * 2 - 1;
      const off = FORCE_OFF - FORCE_BOW * u * u;
      const bx = thrower.x + nx * off + tx * (FORCE_LEN * u);
      const bz = thrower.z + nz * off + tz * (FORCE_LEN * u);
      this.seg(p, bx, bz, bx - nx * FORCE_TOOTH, bz - nz * FORCE_TOOTH, y);
    }

    setShown(this.gForce, true);
    this.force.set(p.build(), 2.5 * this.scale);
    setStyle(this.gForce, 'opacity', (vis * 0.95).toFixed(3));
  }

  /* ------------------------------------------------------------ cutter lanes */

  /**
   * Up to two ground vectors off the offence's committed runners.
   *
   * The stack tells you the shape; this tells you who has left it and where they
   * are going, which in a still frame is otherwise unrecoverable — a photograph
   * of seven athletes contains no velocities at all. Length is 1.15 s of lead at
   * the runner's current speed, so a deep cut draws long and a jog draws nothing,
   * and the arrowhead lands on the space being attacked rather than on the body.
   */
  private drawLanes(f: HudFrame): void {
    const poss = f.possession;
    let a = -1; let b = -1;
    let sa = LANE_SPEED; let sb = LANE_SPEED;
    if (poss !== null && f.discMode !== 'ground') {
      for (let i = 0; i < this.rn; i++) {
        const id = this.rid[i];
        if (this.rteam[i] !== poss || id === f.throwerId || !this.ravail[i]) continue;
        const sp = Math.hypot(this.vx[id], this.vz[id]);
        if (sp <= sa) { if (sp > sb) { b = i; sb = sp; } continue; }
        b = a; sb = sa; a = i; sa = sp;
      }
    }
    // Visibility ramps with the leader's speed rather than snapping at the
    // threshold. A cutter decelerating out of a run would otherwise have their
    // lane vanish between one frame and the next, which reads as a glitch; the
    // ramp turns it into the runner giving the cut up, which is what happened.
    const lead = a >= 0 ? Math.hypot(this.vx[this.rid[a]], this.vz[this.rid[a]]) : 0;
    this.laneIn.target = clamp01((lead - LANE_SPEED) / (LANE_FULL - LANE_SPEED));
    const vis = this.laneIn.step(f.dt);
    if (a < 0 || vis < 0.02) { setShown(this.gLane, false); return; }

    const p = this.pb.reset();
    const h = this.pb2.reset();
    let drawn = 0;
    for (const i of [a, b]) {
      if (i < 0 || drawn >= LANE_MAX) continue;
      const id = this.rid[i];
      const sp = Math.hypot(this.vx[id], this.vz[id]);
      if (sp < LANE_SPEED) continue;
      const ux = this.vx[id] / sp; const uz = this.vz[id] / sp;
      const len = clamp(sp * LANE_LEAD, LANE_MIN_LEN, LANE_MAX_LEN);
      const y = this.ry[i] + 0.014;
      // Start clear of the athlete's own feet so the vector reads as a path
      // ahead of them rather than a line they are standing on.
      const x0 = this.rx[i] + ux * 0.55; const z0 = this.rz[i] + uz * 0.55;
      const x1 = this.rx[i] + ux * len; const z1 = this.rz[i] + uz * len;
      if (!this.seg(p, x0, z0, x1, z1, y)) continue;
      const c = Math.cos(Math.PI * 5 / 6); const s = Math.sin(Math.PI * 5 / 6);
      for (const side of [1, -1]) {
        const bx = ux * c - uz * (s * side);
        const bz = ux * (s * side) + uz * c;
        this.seg(h, x1, z1, x1 + bx * 1.15, z1 + bz * 1.15, y);
      }
      drawn++;
    }
    if (drawn === 0) { setShown(this.gLane, false); return; }
    setShown(this.gLane, true);
    this.lane.set(p.build(), 2.0 * this.scale);
    this.laneHead.set(h.build(), 2.0 * this.scale);
    setStyle(this.gLane, 'opacity', (vis * 0.95).toFixed(3));
  }

  /* --------------------------------------------------------- commanded cut */

  /**
   * The order, on the turf: current position → setup step → the space attacked.
   *
   * Dashed because it has not happened yet, and it outlives the button by 1.5 s
   * because that is the window in which the interesting thing occurs — you gave
   * an order, and now you get to watch whether the runner sells the setup step
   * and whether the lane was ever there. Solid would claim the route is real.
   */
  private drawCut(f: HudFrame): void {
    const c = f.cut;
    if (c.playerId < 0 || c.at < 0) { setShown(this.gCut, false); return; }
    const age = f.t - c.at;
    const alpha = c.held ? 1 : 1 - clamp01(age / CUT_FADE);
    if (alpha <= 0.01) { setShown(this.gCut, false); return; }

    const runner = this.src.player(c.playerId);
    const y = (runner?.groundY ?? 0) + 0.02;
    const p = this.pb.reset();
    let n = 0;
    // The runner's live position anchors the line, so the ghost stays attached
    // to the body it was given to instead of floating where they used to be.
    const ax = runner ? runner.x : c.fromX;
    const az = runner ? runner.z : c.fromZ;
    for (const pt of [[ax, az], [c.setupX, c.setupZ], [c.targetX, c.targetZ]] as const) {
      if (!this.proj.at(pt[0], y, pt[1])) { setShown(this.gCut, false); return; }
      if (n === 0) p.move(this.proj.x, this.proj.y); else p.line(this.proj.x, this.proj.y);
      n++;
    }
    // A small open ring on the target — the space, not a point.
    this.arcInto(p, c.targetX, c.targetZ, y, 0.62, Math.PI * 2, 0);
    setShown(this.gCut, true);
    this.cut.set(p.build(), 1.9 * this.scale);
    setStyle(this.gCut, 'opacity', (alpha * 0.9).toFixed(3));
  }

  /* ------------------------------------------------------- switch preview */

  /**
   * A half-strength ring under the body a held switch would hand you.
   *
   * The spec asks for 40 %. Forcing the mark on and photographing it at that
   * value (`scratchpad/forced.png`) showed the problem with taking that number
   * literally: at 40 % of a 2 px stroke over turf the ring is findable only if
   * you already know where it is, and the entire purpose of the preview is to
   * be found while the button is down. 52 % keeps it plainly subordinate to the
   * committed selection and makes it a mark rather than a rumour.
   *
   * The policy in `Switch.ts` is good and it is not obvious — it scores
   * time-to-threat, refuses to steal the mark, and skips anyone mid-layout. A
   * player who cannot see it working experiences it as the game handing them a
   * random defender. This is the whole fix: hold the button, steer, watch the
   * answer move.
   */
  private drawSwitchPreview(f: HudFrame): void {
    const t = f.switchPreviewId >= 0 ? this.src.player(f.switchPreviewId) : null;
    this.ghostIn.target = t ? 1 : 0;
    const vis = this.ghostIn.step(f.dt);
    if (!t || vis < 0.02) { setShown(this.gGhost, false); return; }
    const d = this.groundRing(t.x, t.z, t.groundY + 0.015, RING_R, this.pb3, 0, 1);
    if (!d) { setShown(this.gGhost, false); return; }
    setShown(this.gGhost, true);
    this.ghostRing.set(d, 2.1 * this.scale);
    setStyle(this.gGhost, 'opacity', (vis * 0.52).toFixed(3));
  }

  /* ------------------------------------------------------------- the reset */

  /**
   * The bail-out, and how much of the count is gone.
   *
   * Two concentric marks on one body, which is the exception the layer allows
   * itself because they answer two different questions about the same decision:
   * the dashed inner ring is *who* (the reset), the outer arc is *when* (the
   * fraction of the stall already spent, drawn as a gauge that closes). Past
   * seven the arc goes solid and takes the one warm tint in the layer, because
   * from there the reset is not an option any more, it is the throw.
   *
   * Suppressed when the reset is already the selected receiver — `drawReceiver`
   * carries that case with a broken bracket, and two marks on one body claiming
   * the same thing is noise pretending to be nuance.
   */
  private drawReset(f: HudFrame): void {
    const id = this.resetId(f);
    const want = id >= 0 && id !== f.receiverId && f.stall >= RESET_FROM
      ? this.src.player(id) : null;
    this.resetIn.target = want ? 1 : 0;
    const vis = this.resetIn.step(f.dt);
    if (!want || vis < 0.02) { setShown(this.gReset, false); return; }

    const y = want.groundY + 0.013;
    const hot = f.stall >= 7;
    const frac = clamp01(f.stall / Math.max(1, f.stallMax));
    // Start the gauge on the far side of the body so its opening faces the
    // camera, the same reasoning as the control ring's gap.
    const cam = this.ctx.camera.position;
    const away = Math.atan2(want.x - cam.x, want.z - cam.z);
    const arc = this.groundRing(want.x, want.z, y, COUNT_R, this.pb, 0, Math.max(0.04, frac), away);
    if (!arc) { setShown(this.gReset, false); return; }
    setShown(this.gReset, true);
    this.countArc.set(arc, (hot ? 3.2 : 2.4) * this.scale);
    this.countArc.colour(hot ? INK_COUNT_HOT : INK_COUNT);

    // The two open ends, turned in. Without them a 40 %-filled gauge is just a
    // stray arc; with them it is a gauge with a zero and a needle, and the eye
    // gets the fraction rather than the shape. This replaces the second, full
    // ring that used to sit inside it: three concentric ellipses on one body
    // came back from the first after-capture as an unreadable target, and the
    // inner ring was carrying no information the gauge did not already carry.
    const q = this.pb2.reset();
    let caps = true;
    for (const e of [0, Math.max(0.04, frac)]) {
      const ang = away + e * Math.PI * 2;
      const sx = Math.sin(ang); const sz = Math.cos(ang);
      caps = this.seg(q, want.x + sx * COUNT_R, want.z + sz * COUNT_R,
        want.x + sx * RESET_R, want.z + sz * RESET_R, y) && caps;
    }
    this.resetRing.set(caps ? q.build() : '', 2.0 * this.scale);
    // From 4 the mark exists; by 7 it is at full strength. Urgency is carried by
    // weight and by how much of the gauge is filled, not by size or motion.
    const gain = 0.42 + 0.58 * clamp01((f.stall - RESET_FROM) / 3);
    setStyle(this.gReset, 'opacity', (vis * gain).toFixed(3));
  }

  /**
   * Nearest available handler behind the disc, cutters priced at 1.7×.
   *
   * The published `dumpId` wins whenever the game has one (stall ≥ 7), so the
   * mark can never point somewhere the panic button would not go; below that the
   * same rule is re-run here off the same positions, which is what lets the
   * reset fade up from stall 4 instead of appearing fully formed at 7.
   */
  private resetId(f: HudFrame): number {
    if (f.dumpId >= 0) return f.dumpId;
    if (f.discMode !== 'held' || f.throwerId < 0 || f.possession === null) return -1;
    const th = this.src.player(f.throwerId);
    if (!th) return -1;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.rn; i++) {
      const id = this.rid[i];
      if (id === f.throwerId || this.rteam[i] !== f.possession || !this.ravail[i]) continue;
      if (f.attackDir * (this.rz[i] - th.z) > 0.5) continue;
      const d = Math.hypot(this.rx[i] - th.x, this.rz[i] - th.z);
      if (d > 22) continue;
      const score = d * (this.rhand[i] ? 1 : 1.7);
      if (score < bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  /* ------------------------------------------------------------- flight arc */

  private drawFlight(f: HudFrame): void {
    const path = f.discMode === 'flight' ? this.src.flight() : null;
    if (!path || path.length < 3) { setShown(this.gFlight, false); return; }

    const p = this.pb.reset();
    let drawn = 0;
    for (let i = 0; i < path.length; i++) {
      const s = path[i];
      if (!this.proj.at(s.x, s.y, s.z)) continue;
      if (drawn === 0) p.move(this.proj.x, this.proj.y);
      else p.line(this.proj.x, this.proj.y);
      drawn++;
    }
    if (drawn < 3) { setShown(this.gFlight, false); return; }
    setShown(this.gFlight, true);
    this.flight.set(p.build(), 2.2 * this.scale);

    // Where it comes down, drawn ON THE TURF so the eye can lead the play, and
    // — the addition — *when*. The ring alone answers half the defensive read;
    // a second ring starting 4.6 m out at 1.7 s and collapsing onto it answers
    // the other half, for free, as a pure function of the predicted flight time
    // the integrator already returns. A big ring closing is "it is coming"; the
    // two rings coincident is "it is here".
    const land = f.landing;
    if (!land.active) { this.landMark.clear(); this.arrive.clear(); return; }
    const ly = land.y + 0.02;
    const q = this.pb2.reset();
    if (!this.arcInto(q, land.x, land.z, ly, LAND_R, Math.PI * 2, 0)) {
      this.landMark.clear(); this.arrive.clear(); return;
    }
    // Two short axis ticks through the centre. At 40 m a 1 m circle is a dozen
    // pixels across; the cross survives the range at which the ring does not.
    for (const ax of [[1, 0], [0, 1]] as const) {
      this.seg(q, land.x - ax[0] * 1.5, land.z - ax[1] * 1.5,
        land.x + ax[0] * 1.5, land.z + ax[1] * 1.5, ly);
    }
    this.landMark.set(q.build(), 2.3 * this.scale);

    const lead = clamp01(land.t / ARRIVE_LEAD);
    if (lead <= 0.02) { this.arrive.clear(); return; }
    const ar = LAND_R + ARRIVE_GAIN * lead;
    const rd = this.groundRing(land.x, land.z, ly, ar, this.pb3, 0, 1);
    if (!rd) { this.arrive.clear(); return; }
    this.arrive.set(rd, 1.8 * this.scale);
    this.arrive.opacity(0.35 + 0.65 * (1 - lead));
  }

  /* ------------------------------------------------ controlled player + ring */

  private drawControlled(f: HudFrame): void {
    const me = f.controlledId >= 0 ? this.src.player(f.controlledId) : null;
    if (!me) { setShown(this.gRing, false); return; }

    // A possession flip announces itself on the body before control moves: the
    // situation has inverted around you and you are still standing in it.
    if (f.flipAt >= 0 && f.flipAt !== this.lastFlip) {
      this.lastFlip = f.flipAt;
      this.pulse.fire(f.t, PULSE_TIME);
    }
    const pp = this.pulse.peek(f.t);
    // Ease out rather than pulseCurve's bounce: a turnover is a hard beat, not
    // a wobble, so the ring snaps to 1.4× and settles back once.
    const grow = pp < 1 ? 1 + PULSE_GAIN * (1 - easeOut(pp)) : 1;
    if (pp >= 1) this.pulse.progress(f.t);
    const r = RING_R * grow;

    // Start the arc on the far side of the ring so its gap sits behind the
    // athlete rather than across his shins.
    const cam = this.ctx.camera.position;
    const away = Math.atan2(me.x - cam.x, me.z - cam.z);

    const track = this.groundRing(me.x, me.z, me.groundY + 0.015, r, this.pb, 0, 1, away);
    if (!track) { setShown(this.gRing, false); return; }
    setShown(this.gRing, true);
    const w = 2.6 * this.scale;
    this.ringTrack.set(track, w);

    this.stamina.target = clamp01(me.stamina);
    const st = this.stamina.step(f.dt);
    const fill = this.groundRing(me.x, me.z, me.groundY + 0.02, r, this.pb2, 0, st, away);
    setAttr(this.ringFill, 'd', fill);
    setAttr(this.ringFill, 'stroke', st > 0.55 ? INK_RING : st > 0.28 ? INK_STAM_LOW : INK_STAM_CRIT);
    setAttr(this.ringFill, 'stroke-width', w.toFixed(2));

    // Defence: a dashed outer ring at 1.05 m. Not a hue change.
    const onDefence = f.possession !== null && me.team !== f.possession;
    this.defenceIn.target = onDefence ? 1 : 0;
    const dv = this.defenceIn.step(f.dt);
    if (dv > 0.02) {
      const outer = this.groundRing(
        me.x, me.z, me.groundY + 0.01, DEFENCE_RING_R * grow, this.pb3, 0, 1, away,
      );
      this.ringOuter.set(outer, 1.7 * this.scale);
      this.ringOuter.opacity(dv);
    } else {
      this.ringOuter.clear();
    }

    // Recovery: 40 % while the body cannot act. A layout costs 2.04 s and the
    // player has to be told they are paying it — an avatar that simply stops
    // answering the stick reads as a dropped input, which is the single most
    // corrosive thing a controller can do.
    setStyle(this.gRing, 'opacity', me.available ? '1' : '0.4');

    // Control chevron, floating a little over the head. Cased and larger than it
    // was: at 1280 wide the old one measured 10 × 7 px, which is a speck.
    if (this.proj.at(me.x, me.groundY + 2.2, me.z)) {
      const s = 9.5 * this.scale;
      const x = this.proj.x; const y = this.proj.y;
      const p = this.pb.reset();
      p.move(x - s, y - s * 0.9).line(x, y + s * 0.55).line(x + s, y - s * 0.9).close();
      const d = p.build();
      setAttr(this.ringChevron, 'd', d);
      setAttr(this.ringChevronCase, 'd', d);
      setShown(this.ringChevron, true);
      setShown(this.ringChevronCase, true);
    } else {
      setShown(this.ringChevron, false);
      setShown(this.ringChevronCase, false);
    }
  }

  /* -------------------------------------------------------------- possession */

  /**
   * The disc pip, over the head of whoever is holding it.
   *
   * It used to be suppressed when the carrier was also the controlled player,
   * on the theory that the control ring already marked that body. It does not
   * mark the same thing: the ring says "you", the pip says "possession", and in
   * a still frame with the human on the disc that left nothing at all saying
   * which team was on offence. Both now draw, stacked — chevron at 2.2 m, pip
   * at 2.5 m.
   */
  private drawCarrier(f: HudFrame): void {
    const carrier = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    if (!carrier || f.discMode !== 'held') { setShown(this.gCarrier, false); return; }
    const own = carrier.id === f.controlledId;
    if (!this.proj.at(carrier.x, carrier.groundY + (own ? 2.62 : 2.34), carrier.z)) {
      setShown(this.gCarrier, false);
      return;
    }
    setShown(this.gCarrier, true);
    const s = this.scale;
    setAttr(this.carrierDisc, 'cx', this.proj.x.toFixed(1));
    setAttr(this.carrierDisc, 'cy', this.proj.y.toFixed(1));
    setAttr(this.carrierDisc, 'rx', (8.5 * s).toFixed(1));
    setAttr(this.carrierDisc, 'ry', (3.7 * s).toFixed(1));
    const p = this.pb.reset();
    p.move(this.proj.x, this.proj.y + 4.6 * s).line(this.proj.x, this.proj.y + 12 * s);
    this.carrierStem.set(p.build(), 1.5 * s);
  }

  /* ---------------------------------------------------------------- receiver */

  /**
   * The selected receiver — solid when the human chose them, broken when the
   * count did.
   *
   * From stall 7 the sim aims the panic button for you (`Game.ts`'s dump
   * default), so past that point the bracket is usually on a body nobody
   * picked. Drawn identically, that is the HUD claiming an intention the player
   * never had. Same shape, same hue, broken stroke and a little dimmer — "this
   * is the throw, and the count is the one saying so".
   */
  private drawReceiver(f: HudFrame): void {
    const r = f.receiverId >= 0 ? this.src.player(f.receiverId) : null;
    if (!r) { setShown(this.gRecv, false); return; }
    const d = this.bracketPath(r, this.pb, 1);
    if (!d) { setShown(this.gRecv, false); return; }
    this.recvBrackets.set(d, (f.receiverAuto ? 2.0 : 2.4) * this.scale);
    this.recvBrackets.colour(f.receiverAuto ? INK_RECV_AUTO : INK_RECV);
    this.recvBrackets.dash(f.receiverAuto ? '5 4' : 'none');
    setShown(this.gRecv, true);
  }

  /**
   * Four corner brackets around an athlete, sized by their projected height —
   * a full box would read as a debug AABB. `k` scales the box so a suggestion
   * can sit inside a selection without the two fighting.
   */
  private bracketPath(r: { x: number; z: number; groundY: number }, pb: PathBuilder, k: number): string {
    if (!this.proj.at(r.x, r.groundY + 0.98, r.z)) return '';
    const cx = this.proj.x; const cy = this.proj.y;
    if (!this.proj.at(r.x, r.groundY + 1.96, r.z)) return '';
    const halfH = Math.max(14, Math.abs(cy - this.proj.y) * 1.12) * k;
    const halfW = halfH * 0.62;
    const arm = Math.max(5, halfH * 0.3);

    const p = pb.reset();
    p.move(cx - halfW, cy - halfH + arm).line(cx - halfW, cy - halfH).line(cx - halfW + arm, cy - halfH);
    p.move(cx + halfW - arm, cy - halfH).line(cx + halfW, cy - halfH).line(cx + halfW, cy - halfH + arm);
    p.move(cx + halfW, cy + halfH - arm).line(cx + halfW, cy + halfH).line(cx + halfW - arm, cy + halfH);
    p.move(cx - halfW + arm, cy + halfH).line(cx - halfW, cy + halfH).line(cx - halfW, cy + halfH - arm);
    return p.build();
  }

  /* ------------------------------------------------------------- throw meter */

  private drawMeter(f: HudFrame): void {
    // The meter belongs to the disc, not to the button: it appears the moment
    // the athlete you are driving is the one holding it, so the perfect window
    // is on screen before the first press rather than after it.
    const armed = f.controlledId >= 0 && f.throwerId === f.controlledId && f.discMode === 'held';
    this.meterIn.target = armed ? 1 : 0;
    const vis = this.meterIn.step(f.dt);
    if (vis < 0.005 && !armed) { setShown(this.meter, false); return; }
    setShown(this.meter, true);

    const e = easeOut(vis);
    setStyle(this.meter, 'transform', `translate3d(-50%,${((1 - e) * 1.6).toFixed(3)}em,0) scale(${(0.96 + 0.04 * e).toFixed(4)})`);
    // Idle, the meter is a standing affordance, not a readout — it exists so the
    // perfect window is learnable before the first press. At 0.82 it competed
    // with the bug for the eye in every still; 0.55 keeps it legible and stops it
    // reading as live data when the power bar is empty.
    setStyle(this.meter, 'opacity', (e * (f.charging ? 1 : 0.55)).toFixed(3));

    this.power.target = f.charging ? f.chargePower : 0;
    this.quality.target = f.charging ? f.chargeQuality : 0;
    const pw = this.power.step(f.dt);
    const q = this.quality.step(f.dt);

    setStyle(this.mFill, 'transform', `scaleX(${Math.max(0.0015, pw).toFixed(4)})`);
    // A percentage translate resolves against the element's own 2 px width, not
    // the track's — so the play-head is driven off the track's known em width
    // (panel 20.5em, 1em padding a side, 1px borders) and stays compositor-only.
    setStyle(this.mHead, 'transform', `translateX(calc((18.5em - 2px) * ${pw.toFixed(4)}))`);
    setStyle(this.mHead, 'opacity', f.charging ? '1' : '0');

    const c0 = q > 0.8 ? '#3fbe86' : q > 0.5 ? '#c9a53c' : '#b0453a';
    const c1 = q > 0.8 ? '#7cf0b6' : q > 0.5 ? '#ffc866' : '#ff7a5e';
    setStyle(this.mFill, '--f0', c0);
    setStyle(this.mFill, '--f1', c1);

    // Perfect window, expressed on the same axis the fill uses.
    const maxHold = Math.max(0.2, f.maxHold);
    const lo = clamp01((f.perfectHold - f.perfectHalf) / maxHold);
    const hi = clamp01((f.perfectHold + f.perfectHalf) / maxHold);
    setStyle(this.mBand, 'left', `${(lo * 100).toFixed(2)}%`);
    setStyle(this.mBand, 'width', `${Math.max(0.6, (hi - lo) * 100).toFixed(2)}%`);
    setStyle(this.mCaret, 'left', `${(((lo + hi) * 0.5) * 100).toFixed(2)}%`);

    // The green window is the most saturated thing the HUD ever draws, and the
    // art direction reserves saturation for the kits and the disc. It earns that
    // while a throw is being charged; sitting idle behind an empty track it does
    // not, so it drops back to a hint of itself.
    setStyle(this.mBand, 'opacity', f.charging ? '1' : '0.45');
    setStyle(this.mCaret, 'opacity', f.charging ? '1' : '0.45');

    setText(this.mType, f.chargeType);
    setText(this.mQual, f.charging ? qualityWord(f.chargeQuality) : 'Ready');
    // An idle meter reporting "0%" reads as a live measurement that happens to be
    // zero. An em dash reads as "not yet", which is what it means.
    setText(this.mPower, f.charging || pw > 0.004 ? `${Math.round(pw * 100)}%` : '—');
    void this.brands;
  }

  /* ----------------------------------------------------------- geometry glue */

  /** One run of the spine between two axis coordinates. Skips a degenerate run. */
  private spineRun(
    p: PathBuilder, cx: number, cz: number, ax: number, az: number,
    y: number, t0: number, t1: number,
  ): boolean {
    if (t1 - t0 < 0.6) return false;
    return this.seg(p, cx + ax * t0, cz + az * t0, cx + ax * t1, cz + az * t1, y);
  }

  /** Append one ground segment. False when either end is behind the camera. */
  private seg(p: PathBuilder, x0: number, z0: number, x1: number, z1: number, y: number): boolean {
    if (!this.proj.at(x0, y, z0)) return false;
    const sx = this.proj.x; const sy = this.proj.y;
    if (!this.proj.at(x1, y, z1)) return false;
    p.move(sx, sy).line(this.proj.x, this.proj.y);
    return true;
  }

  /** Append an arc of `span` radians centred on bearing `mid`, radius `r`. */
  private arcInto(
    p: PathBuilder, cx: number, cz: number, y: number, r: number, span: number, mid: number,
  ): boolean {
    const n = Math.max(6, Math.round((RING_SEGMENTS * span) / (Math.PI * 2)));
    for (let i = 0; i <= n; i++) {
      const a = mid + span * (i / n - 0.5);
      if (!this.proj.at(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r)) return false;
      if (i === 0) p.move(this.proj.x, this.proj.y); else p.line(this.proj.x, this.proj.y);
    }
    return true;
  }

  /**
   * A circle on the ground, projected point by point. 40 samples is enough that
   * the polyline reads as a curve at any range we ever draw one, and it costs 40
   * matrix multiplies — cheaper than the CSS the panels above it use.
   */
  private groundRing(
    cx: number, cz: number, y: number, radius: number,
    pb: PathBuilder, from: number, to: number, startAngle = 0,
  ): string {
    if (to <= from + 1e-4) return '';
    const p = pb.reset();
    const n = Math.max(4, Math.round(RING_SEGMENTS * (to - from)));
    let drawn = 0;
    for (let i = 0; i <= n; i++) {
      const t = from + ((to - from) * i) / n;
      const a = startAngle + t * Math.PI * 2;
      if (!this.proj.at(cx + Math.sin(a) * radius, y, cz + Math.cos(a) * radius)) return '';
      if (drawn === 0) p.move(this.proj.x, this.proj.y); else p.line(this.proj.x, this.proj.y);
      drawn++;
    }
    if (to - from >= 0.999) p.close();
    return p.build();
  }
}

function qualityWord(q: number): string {
  if (q >= 0.94) return 'Perfect';
  if (q >= 0.78) return 'Clean';
  if (q >= 0.55) return 'Loose';
  return 'Rushed';
}
