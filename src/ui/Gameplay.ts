/**
 * The gameplay layer: everything anchored to the world rather than to the
 * frame, plus the throw meter.
 *
 * ## What happened to the previous version of this file
 *
 * The round-5 brief asked for legibility and got it, and legibility turned out
 * to be the wrong target. Measured on `shots/r5-base`, five to seven world
 * gizmos were on screen on *every single frame* of live play — a fitted stack
 * spine twenty to thirty metres long with rungs and an arrowhead, up to two
 * dashed cutter-lane vectors with their own arrowheads, a toothed force fence, a
 * ground stall gauge with turned-in end caps, a control ring, a dashed defence
 * ring, a carrier pip and its stem. All of them near-white, all of them at
 * comparable weight, all of them drawn on top of the athletes they described.
 * Two independent critics reading those frames called it "unreadable white
 * spaghetti", "telestrator chalk-art burned into the field", and — the one that
 * actually settles it — said a channel surfer would read the frame as a
 * coaching-analysis segment rather than as live play. Crop
 * `shots/r5-base/live-07.png` at (240,360) 440×100 and it is not arguable.
 *
 * A telestrator freeze-frame and a broadcast frame want opposite things. A
 * freeze-frame is a still with no time in it, so every structure has to be
 * redrawn on top of the bodies; that is what the old header reasoned itself
 * into, and the reasoning is sound for the artefact it was aimed at and wrong
 * for a game. Live play *has* time in it. A column of bodies moving together is
 * visibly a stack. A runner accelerating is visibly cutting. Redrawing those in
 * white line-art buys nothing and costs the frame.
 *
 * ## The rule this version obeys
 *
 * Every mark answers one question: **does the viewer need this on this frame,
 * or only when something happens?** Two marks passed the first test. Everything
 * else is now fired by an event, held, and faded out.
 *
 * ALWAYS ON — two marks, one body each:
 *
 *   selection   the athlete you are driving. Non-negotiable: a player who
 *               cannot find their avatar cannot play. Ring, stamina arc, caret
 *               over the head, and an edge chevron when the body is off-frame.
 *   possession  a small hollow disc glyph over the carrier's head — and *only*
 *               when the carrier is not the player you are driving, because
 *               otherwise the selection caret and the pip stack into two glyphs
 *               over one skull and the pip becomes the thing the eye tracks
 *               instead of the disc.
 *
 * ON AN EVENT, THEN GONE:
 *
 *   force       fired when a mark is first read, when the force flips, and
 *               0.55 s after a new thrower takes possession. 1.4 s at strength,
 *               0.7 s fade. That is the moment the answer is news; the rest of
 *               the possession it is a fence lying in the grass.
 *   landing     a single small ring where a live throw comes down. Only while
 *               the disc is in the air, which is about a second.
 *   cut ghost   the route you ordered, while the button is down and for 1.5 s
 *               after — the window in which you are judging the execution.
 *   receiver    brackets on the body the throw is aimed at, broken when the
 *               stall count aimed it rather than you.
 *   switch      a half-strength ring under the body a held switch would give
 *               you. Exists only while the button is held.
 *   turnover    the selection ring snaps to 1.4× and settles, once.
 *
 * DELETED, and the frame is the argument: the stack spine, its rungs and its
 * arrowhead; both cutter lanes and their heads; the ground stall gauge and its
 * end caps (the scorebug already owns the count, and two gauges for one number
 * is how a HUD manufactures disagreement); the collapsing arrival ring; the
 * landing cross; the predicted flight arc; the carrier's stem. Roughly nine
 * tenths of the ink in the old frames, and with it the roster scan, the
 * differenced-velocity table and the total-least-squares stack fit that fed
 * them.
 *
 * ## Casing, and why the selection ring is the one tinted mark
 *
 * The tele sits 45 m out at a 24–30° lens and an athlete is about 35 px tall,
 * so every mark here is a hairline. A hairline of one colour cannot hold
 * against both ends of this frame's range at once: sunlit turf is L ≈ 0.16 and
 * the away kit is white at L ≈ 0.88. So every stroke is drawn twice — a dark
 * casing 2.3 px wider underneath, then the light core. Whichever background the
 * mark crosses, one of the two strokes is carrying the contrast. It is the
 * cartographic road-casing trick and it costs one extra `d` write per mark.
 *
 * The second critic's most useful number was that the selection ring sat within
 * [17,30,52] RGB of the pass-lane overlays. Most of that is fixed by deletion —
 * there are no pass-lane overlays any more — but relying on that alone would
 * leave the one mark a player *must* find at the same near-white as every mark
 * they merely may. So the selection owns a hue nobody else has: a cool cyan at
 * 30 % saturation, which `docs/art-direction.md` permits (everything but the two
 * kits and the disc under 50 %) and which is nowhere near navy, near-white,
 * mint or gold. Its casing is also darker and heavier than the rest of the
 * layer's, so it reads as a *cursor* — the only closed, solid, full-weight ring
 * on the pitch, with the only filled glyph above it.
 *
 * Sampled off the rendered pixels of `shots/r6-ui/live-00.png` — core measures
 * exactly rgb(178,232,255) (L 0.744), casing rgb(13,19,13) (L 0.006):
 *
 *   | background            | core   | casing | whichever carries it |
 *   |-----------------------|--------|--------|----------------------|
 *   | turf, sunlit          | 4.07:1 | 3.50:1 | **4.07:1**           |
 *   | turf, shadow          | 3.91:1 | 3.63:1 | **3.91:1**           |
 *   | turf, near field      | 3.85:1 | 3.69:1 | **3.85:1**           |
 *   | home kit (blue)       | 5.08:1 | 2.80:1 | **5.08:1**           |
 *   | away kit, shadowed    | 5.35:1 | 2.66:1 | **5.35:1**           |
 *   | away kit, lit         | 3.23:1 | 4.40:1 | **4.40:1**           |
 *   | the disc              | 1.81:1 | 7.84:1 | **7.84:1**           |
 *   | its own casing        |  14.21:1        |                      |
 *
 * Worst case 3.85:1, against a 3:1 floor for a graphical object, and no
 * background in the frame where both strokes fail at once — which is the whole
 * argument for casing. Against the layer's own remaining marks the separation is
 * ΔRGB [-15,34,58] from the force fence as rendered, [39,-4,65] from the
 * receiver bracket and [-62,-15,0] from the landing ring; every one of those is
 * also a different *shape* (toothed rail, corner brackets, dashed ring), and at
 * most two of them are ever on the pitch at once.
 *
 * The world-anchored shapes are true projections, not billboards: a ground ring
 * is 40 world points run through the camera and joined, so it sits on the turf
 * in perspective and foreshortens correctly.
 *
 * ## One thing this file did NOT fix, on purpose
 *
 * The round-5 critics reported the scorebug stall ring as "noise" — 4, 0, 3, 5,
 * 0, 2, 4, 0 across eight frames — and asked whether the gauge misreads the
 * model or the model is non-monotonic. Neither. Probed at 0.4 s (against 2.5 s
 * capture gaps) the count runs 0,0,1,1,1,2,2,3,3,3,4,4,5,5,5,6,6,7,7,7 and then
 * resets on a completion, every time, exactly as `GameState.tickStall` and
 * `Rules.stallCountFor` specify. The sampled sequence is one correct count seen
 * across three completed passes. The arc geometry is right too: measured
 * angularly on `shots/r5-base`, seven of the eight frames draw within 11° of
 * `stall/stallMax × 360°`. See the task report for the one frame that does not
 * and for whose file it is in — it is not this one.
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
const DEFENCE_RING_R = 0.98;

/**
 * The force fence: a short toothed barrier off the thrower's closed shoulder.
 *
 * The geometry survives from the previous pass because the geometry was right —
 * a straight line has no curvature for perspective to eat, its long axis lands
 * broadside to the camera whenever the force is set to a sideline, and a comb
 * has a face so the teeth carry the direction at any size. What changed is
 * *when* it draws. It used to be on for every frame the disc was held, which on
 * a wide frame is a white bracket permanently wrapped around two bodies. It now
 * appears when the answer changes and leaves.
 */
/**
 * 1.45 m rather than 1.15: at 1.15 the rail clipped the top of the selection
 * ring whenever the controlled player was also the thrower, and two marks that
 * touch read as one mark (`shots/r6-ui-edge/tier-low.png`). 0.83 m of clearance
 * outside a 0.62 m ring is about 16 px at tele range, which is enough.
 */
const FORCE_OFF = 1.45;
const FORCE_LEN = 0.95;
const FORCE_TOOTH = 0.42;
const FORCE_TEETH = 5;
/** A shallow bow toward the thrower, so the fence wraps rather than slices. */
const FORCE_BOW = 0.16;
/** Seconds at strength, then seconds of fade. */
const FORCE_HOLD = 1.4;
const FORCE_FADE = 0.7;
/**
 * Seconds between a new thrower taking possession and the fence appearing.
 *
 * Measured on `shots/r6-ui/live-01.png`, firing the force on the catch put a
 * 2.5 m white ladder next to the selection ring on the one frame the player is
 * hunting for their own body. Both marks were competing for the same half
 * second and the loud one was the one that mattered least. Staggering it costs
 * nothing and orders the read: you land, then the mark tells you which way it
 * is shutting you down.
 */
const FORCE_DELAY = 0.55;
/** Radians of change that counts as a new call rather than the mark drifting. */
const FORCE_FLIP = 0.7;

/** Landing ring radius, metres. Was 1.0 plus a 3 m cross; the cross is gone. */
const LAND_R = 0.85;

/** Seconds a released cut order stays on the turf before it is gone. */
const CUT_FADE = 1.5;
/** Turnover pulse: 1.4× radius, 0.3 s. */
const PULSE_TIME = 0.3;
const PULSE_GAIN = 0.4;

/**
 * How long the throw meter stays up after the disc lands in your hands.
 *
 * The panel used to be armed by possession and left there, which on a capture
 * of ordinary play meant twelve and a half seconds of byte-identical pixels
 * across two possession changes — a readout that never reads anything is
 * indistinguishable from a frozen UI, and one critic read it as exactly that.
 * It now behaves like a prompt: it arrives when the disc does, shows you where
 * the perfect window sits, and retires. Pressing the button brings it straight
 * back, and while you are charging it is live data and stays.
 */
const METER_ARM = 2.4;
const METER_ARM_FADE = 0.5;

/* ------------------------------------------------------------------ palette */

/**
 * The casing. Near-black at just over half alpha: dark enough to hold a light
 * core against sunlit turf, transparent enough that it never reads as a second
 * line of its own over shadow.
 */
const CASE_INK = 'rgba(6,12,9,.58)';
/** Heavier and darker, for the one mark that may never be missed. */
const CASE_SEL = 'rgba(3,9,6,.88)';
/** Extra width the casing carries, in CSS px. Deliberately unscaled — this is a
 *  pixel-contrast device, not a piece of geometry. */
const CASE_W = 2.3;

/** S = 30 %. The layer's one hue, and it belongs to the selection alone. */
const INK_SEL = 'rgb(178,232,255)';
const INK_FORCE = 'rgba(228,240,252,.82)';
const INK_CUT = 'rgba(198,219,244,.62)';
const INK_LAND = 'rgba(240,247,255,.74)';
const INK_RECV = 'rgba(139,236,190,.88)';
const INK_RECV_AUTO = 'rgba(139,236,190,.62)';
/** The possession pip. Near-neutral and quiet: the disc itself is the subject. */
const INK_DISC = 'rgba(236,243,252,.66)';
/** S = 49 % / 47 %. The art direction's cap is 50 %. */
const INK_STAM_LOW = 'rgb(240,178,122)';
const INK_STAM_CRIT = 'rgb(232,142,124)';

/* ------------------------------------------------------------------ helpers */

/** Screen-space projection of a world point, in CSS pixels. */
class Projector {
  x = 0;
  y = 0;
  ok = false;
  /** True when the point was behind the camera and had to be pushed forward. */
  behind = false;

  constructor(private ctx: Ctx) {}

  at(x: number, y: number, z: number): boolean {
    const cam = this.ctx.camera;
    _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    if (_v.z > -0.08) { this.ok = false; this.behind = true; return false; }
    this.behind = false;
    _v.applyMatrix4(cam.projectionMatrix);
    this.x = (_v.x * 0.5 + 0.5) * this.ctx.width;
    this.y = (-_v.y * 0.5 + 0.5) * this.ctx.height;
    this.ok = Math.abs(this.x) < 12000 && Math.abs(this.y) < 12000;
    return this.ok;
  }

  /**
   * Same projection, but a point behind the camera is clamped to the near plane
   * instead of failing. The result is meaningless as a position and correct as a
   * *direction*, which is all the off-frame indicator needs: the sign of the
   * view-space x survives the clamp, so the chevron lands on the side of the
   * frame the athlete is actually on rather than the mirrored one.
   */
  toward(x: number, y: number, z: number): void {
    const cam = this.ctx.camera;
    _v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
    if (_v.z > -0.08) _v.z = -0.08;
    _v.applyMatrix4(cam.projectionMatrix);
    this.x = (_v.x * 0.5 + 0.5) * this.ctx.width;
    this.y = (-_v.y * 0.5 + 0.5) * this.ctx.height;
  }
}

/**
 * One cased stroke: a dark path and a light path carrying identical geometry.
 *
 * Both are children of the same parent and the casing is created first, so
 * document order does the compositing. Marks that would overlap each other are
 * built as a *single* `Mark` with several subpaths in one `d` — otherwise the
 * second mark's casing would notch the first mark's core, which is what makes
 * the force fence's teeth look like they are cutting the rail rather than
 * growing out of it.
 */
class Mark {
  private under: SVGPathElement;
  private over: SVGPathElement;

  constructor(
    parent: SVGElement, colour: string,
    cap: 'round' | 'butt' | 'square' = 'round',
    private caseW = CASE_W,
    caseInk = CASE_INK,
  ) {
    this.under = svgEl('path', undefined, parent);
    this.over = svgEl('path', undefined, parent);
    for (const n of [this.under, this.over]) {
      setAttr(n, 'fill', 'none');
      setAttr(n, 'stroke-linejoin', 'round');
      setAttr(n, 'stroke-linecap', cap);
    }
    setAttr(this.under, 'stroke', caseInk);
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
  private gCut: SVGGElement;
  private cut: Mark;
  private gForce: SVGGElement;
  private force: Mark;
  private gLand: SVGGElement;
  private landMark: Mark;
  private gGhost: SVGGElement;
  private ghostRing: Mark;
  private gRecv: SVGGElement;
  private recvBrackets: Mark;
  private gCarrier: SVGGElement;
  private carrierCase: SVGEllipseElement;
  private carrierDisc: SVGEllipseElement;
  private gSel: SVGGElement;
  private selOuter: Mark;
  private selTrack: Mark;
  private selFill: SVGPathElement;
  private selTether: Mark;
  private selCaret: SVGPathElement;
  private selCaretCase: SVGPathElement;
  private selEdge: SVGPathElement;
  private selEdgeCase: SVGPathElement;

  /* meter */
  private mType: HTMLElement;
  private mQual: HTMLElement;
  private mKey: HTMLElement;
  private mBand: HTMLElement;
  private mFill: HTMLElement;
  private mHead: HTMLElement;
  private mPower: HTMLElement;
  private mCaret: HTMLElement;

  private pb = new PathBuilder();
  private pb2 = new PathBuilder();
  private pb3 = new PathBuilder();
  private scale = 1;
  private power = new Motion(0, 26);
  private quality = new Motion(0, 18);
  private meterIn = new Motion(0, 9);
  private stamina = new Motion(1, 6);
  /** Fires when the disc arrives in the controlled player's hands. */
  private armClip = new Clip();
  private wasArmed = false;

  /* off-ball legibility */
  private forceClip = new Clip();
  /**
   * The break bearing, unwrapped. Kept as a spring even though the mark is now
   * transient: a mark that flips while it is still on screen should sweep
   * across the thrower the way a marker's own body does, not pop.
   */
  private forceAngle = new Motion(0, 11);
  private forceHas = false;
  private forceShownAngle = 0;
  private forceThrower = -1;
  /** Sim time the staggered fire is due, or -1 when nothing is pending. */
  private forceDue = -1;
  private defenceIn = new Motion(0, 8);
  private ghostIn = new Motion(0, 14);
  private pulse = new Clip();
  private lastFlip = -1;

  constructor(parent: HTMLElement, ctx: Ctx, src: HudSource, brands: [TeamBrand, TeamBrand]) {
    this.ctx = ctx;
    this.src = src;
    this.brands = brands;
    this.proj = new Projector(ctx);

    this.svg = svgEl('svg', 'ug-svg', parent);
    this.svg.setAttribute('viewBox', `0 0 ${ctx.width} ${ctx.height}`);

    /* --- commanded cut ---------------------------------------------------- */
    // First and dimmest: it is a route that has not happened yet, so it must
    // never out-draw a mark describing something that has.
    this.gCut = svgEl('g', undefined, this.svg);
    this.cut = new Mark(this.gCut, INK_CUT);
    this.cut.dash('7 6');
    setShown(this.gCut, false);

    /* --- the force -------------------------------------------------------- */
    this.gForce = svgEl('g', undefined, this.svg);
    this.force = new Mark(this.gForce, INK_FORCE);
    setShown(this.gForce, false);

    /* --- where a live throw lands ----------------------------------------- */
    this.gLand = svgEl('g', undefined, this.svg);
    this.landMark = new Mark(this.gLand, INK_LAND);
    // Dashed, and the selection ring is solid. They are the only two rings the
    // layer draws and they can legitimately overlap — a throw aimed at the body
    // you are driving puts one inside the other, which is exactly what
    // `shots/r6-ui/live-04.png` caught. Hue separates them at a glance and the
    // broken stroke separates them at any size; it is also the honest treatment,
    // because the disc is not there yet.
    this.landMark.dash('7 5');
    setShown(this.gLand, false);

    /* --- switch preview --------------------------------------------------- */
    this.gGhost = svgEl('g', undefined, this.svg);
    this.ghostRing = new Mark(this.gGhost, 'rgba(224,238,255,.9)');
    this.ghostRing.dash('5 5');
    setShown(this.gGhost, false);

    /* --- receiver --------------------------------------------------------- */
    this.gRecv = svgEl('g', undefined, this.svg);
    this.recvBrackets = new Mark(this.gRecv, INK_RECV, 'square');
    setShown(this.gRecv, false);

    /* --- possession ------------------------------------------------------- */
    this.gCarrier = svgEl('g', undefined, this.svg);
    this.carrierCase = svgEl('ellipse', undefined, this.gCarrier);
    this.carrierDisc = svgEl('ellipse', undefined, this.gCarrier);
    setAttr(this.carrierCase, 'fill', 'none');
    setAttr(this.carrierCase, 'stroke', 'rgba(6,12,9,.6)');
    setAttr(this.carrierDisc, 'fill', 'none');
    setAttr(this.carrierDisc, 'stroke', INK_DISC);
    setShown(this.gCarrier, false);

    /* --- the athlete you are driving -------------------------------------- */
    // Last, so nothing in the layer can be drawn over it.
    this.gSel = svgEl('g', undefined, this.svg);
    // On defence the ring gains an outer dashed circle rather than a hue: the
    // two kits and the disc own every saturated pixel in the frame, and a HUD
    // that starts colouring itself by game state takes that back one element at
    // a time. A broken outline reads as "contesting" without spending any.
    this.selOuter = new Mark(this.gSel, 'rgba(178,232,255,.55)', 'round', 1.6, CASE_SEL);
    this.selOuter.dash('4 6');
    this.selTrack = new Mark(this.gSel, 'rgba(178,232,255,.30)', 'round', 3.4, CASE_SEL);
    // The stamina fill rides on the track's casing rather than carrying its own:
    // they are the same circle, and a second casing would darken the track it
    // sits on.
    this.selFill = svgEl('path', undefined, this.gSel);
    setAttr(this.selFill, 'fill', 'none');
    setAttr(this.selFill, 'stroke', INK_SEL);
    setAttr(this.selFill, 'stroke-linecap', 'round');
    this.selTether = new Mark(this.gSel, INK_SEL, 'butt', 2.0, CASE_SEL);
    this.selCaretCase = svgEl('path', undefined, this.gSel);
    this.selCaret = svgEl('path', undefined, this.gSel);
    setAttr(this.selCaretCase, 'fill', 'none');
    setAttr(this.selCaretCase, 'stroke', CASE_SEL);
    setAttr(this.selCaretCase, 'stroke-width', '4.2');
    setAttr(this.selCaretCase, 'stroke-linejoin', 'round');
    setAttr(this.selCaret, 'fill', INK_SEL);
    setAttr(this.selCaret, 'stroke', 'none');
    this.selEdgeCase = svgEl('path', undefined, this.gSel);
    this.selEdge = svgEl('path', undefined, this.gSel);
    setAttr(this.selEdgeCase, 'fill', 'none');
    setAttr(this.selEdgeCase, 'stroke', CASE_SEL);
    setAttr(this.selEdgeCase, 'stroke-width', '4.6');
    setAttr(this.selEdgeCase, 'stroke-linejoin', 'round');
    setAttr(this.selEdge, 'fill', INK_SEL);
    setAttr(this.selEdge, 'stroke', 'none');
    setShown(this.gSel, false);

    /* --- throw meter ------------------------------------------------------ */
    this.meter = el('div', 'ug-panel ug-meter', parent);
    // Off the centre line. Dead-centre-bottom is the one region a broadcast
    // package keeps clear — it is where burned-in captions, tickers and the
    // safe-title margin live — and a control affordance parked there reads as
    // furniture rather than as feedback. Bottom right is free: the lower third
    // is bottom left and the summary panel is right-middle.
    setStyle(this.meter, 'left', 'auto');
    setStyle(this.meter, 'right', '1.7em');
    setStyle(this.meter, 'transform-origin', '100% 100%');
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
    this.mKey = el('span', 'k', ft);
    setText(this.mKey, 'Power');
    this.mPower = el('span', 'v', ft);
    // Contrast floor, measured rather than asserted. The theme's `--ug-ink3` is
    // `rgba(146,169,197,.55)`, which over this panel's glass composites to about
    // rgb(88,104,119) — L 0.133 against a panel at L 0.009, or **3.1:1**. That
    // is under the 4.5:1 body-text floor at 9 px, and it was carrying the one
    // word on the panel that ever changes ("Ready" / "Rushed" / "Perfect"), so
    // it is overridden here. Sampled off `shots/r6-ui/live-01.png` at the
    // panel's *dimmest* state (the prompt, 85 %), rgb(206,222,242) measures
    // **5.7:1** against the rendered panel and higher again at full opacity.
    // The static "Power" caption is lifted to clear the same floor.
    setStyle(this.mQual, 'color', 'rgb(206,222,242)');
    setStyle(this.mKey, 'color', 'rgb(190,206,228)');
    setStyle(this.mPower, 'color', 'rgb(214,228,246)');
    setShown(this.meter, false);
  }

  resize(w: number, h: number): void {
    setAttr(this.svg, 'viewBox', `0 0 ${w} ${h}`);
    // Never below nominal. A smaller frame is where a hairline dies first, so
    // the weight floor is 0.95× and it only ever goes up.
    this.scale = clamp(w / 1700, 0.95, 1.45);
  }

  restage(f: HudFrame): void {
    this.power.set(f.chargePower);
    this.quality.set(f.chargeQuality);
    this.meterIn.set(0);
    this.stamina.set(1);
    this.armClip.stop();
    this.wasArmed = false;
    // A tableau is a still: every gizmo has to be at its settled value on the
    // first frame the shutter sees, and no clip may be mid-flight. The force is
    // the exception that gets *fired* rather than cleared — a posed broadcast
    // frame is exactly the frame that should be showing the mark, and a
    // transient that happens to be mid-fade when the shutter opens is a
    // photograph of an animation rather than of a decision.
    this.forceAngle.set(f.forceAngle);
    this.forceHas = f.forceKnown;
    this.forceShownAngle = f.forceAngle;
    this.forceThrower = f.throwerId;
    this.forceDue = -1;
    if (f.forceKnown) this.forceClip.fire(f.t, FORCE_HOLD + FORCE_FADE);
    else this.forceClip.stop();
    this.defenceIn.set(0);
    this.ghostIn.set(0);
    this.pulse.stop();
    this.lastFlip = f.flipAt;
  }

  /* ------------------------------------------------------------------ frame */

  update(f: HudFrame): void {
    this.drawCut(f);
    this.drawForce(f);
    this.drawLanding(f);
    this.drawSwitchPreview(f);
    this.drawReceiver(f);
    this.drawCarrier(f);
    this.drawSelection(f);
    this.drawMeter(f);
  }

  /* -------------------------------------------------------------- the force */

  /**
   * A 2.5 m fence set 1.3 m off the thrower's break shoulder, teeth pointing in.
   *
   * This is the one annotation a newcomer genuinely cannot infer from watching
   * bodies. Everything else the layer used to mark was visible if you knew where
   * to look — a stack is a column, a cut is somebody running — and that is
   * precisely why those marks are gone and this one survived. The force is a
   * *rule the defence is imposing*, expressed as one defender standing four feet
   * off one shoulder, and no amount of watching recovers it.
   *
   * But it is news exactly three times: when a mark first sets up, when the
   * force flips, and when a new thrower gets the disc. Between those it is a
   * fact you already have. So it is fired, held for 1.5 s and faded over 0.7 s,
   * and for the other four fifths of a possession the grass in front of the
   * thrower is grass.
   */
  private drawForce(f: HudFrame): void {
    const thrower = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    const live = f.forceKnown && !!thrower && f.discMode === 'held';

    if (live) {
      if (f.throwerId !== this.forceThrower) { this.forceHas = false; this.forceThrower = f.throwerId; }
      if (!this.forceHas) {
        this.forceAngle.set(f.forceAngle);
        this.forceShownAngle = f.forceAngle;
        this.forceHas = true;
        this.forceDue = f.t + FORCE_DELAY;
      } else {
        // Unwrap onto the nearest branch so a flip sweeps the short way round
        // instead of unwinding through five o'clock.
        let d = f.forceAngle - this.forceAngle.target;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.forceAngle.target += d;
        let s = f.forceAngle - this.forceShownAngle;
        while (s > Math.PI) s -= Math.PI * 2;
        while (s < -Math.PI) s += Math.PI * 2;
        // A mark drifting round the thrower is not a new call; a flip is.
        if (Math.abs(s) > FORCE_FLIP) {
          this.forceShownAngle = f.forceAngle;
          this.forceClip.fire(f.t, FORCE_HOLD + FORCE_FADE);
          this.forceDue = -1;
        }
      }
    } else if (f.discMode !== 'held') {
      this.forceHas = false;
      this.forceThrower = -1;
      this.forceDue = -1;
    }

    if (this.forceDue >= 0 && f.t >= this.forceDue) {
      this.forceDue = -1;
      if (live) this.forceClip.fire(f.t, FORCE_HOLD + FORCE_FADE);
    }

    const p01 = this.forceClip.peek(f.t);
    if (p01 >= 1 || !this.forceClip.running || !thrower) {
      if (p01 >= 1) this.forceClip.progress(f.t);
      setShown(this.gForce, false);
      return;
    }
    const held = FORCE_HOLD / (FORCE_HOLD + FORCE_FADE);
    const vis = p01 <= held ? 1 : 1 - (p01 - held) / (1 - held);

    const a = this.forceAngle.step(f.dt);
    const y = thrower.groundY + 0.012;
    // Outward normal (toward the mark) and the fence's own axis.
    const nx = Math.sin(a); const nz = Math.cos(a);
    const tx = nz; const tz = -nx;
    const p = this.pb.reset();
    // The rail, as eight segments so the shallow bow shows. Any point failing to
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
    this.force.set(p.build(), 1.8 * this.scale);
    setStyle(this.gForce, 'opacity', (vis * 0.82).toFixed(3));
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
    setShown(this.gCut, true);
    this.cut.set(p.build(), 1.7 * this.scale);
    setStyle(this.gCut, 'opacity', (alpha * 0.85).toFixed(3));
  }

  /* ------------------------------------------------------------- the landing */

  /**
   * One small ring where a live throw comes down. Nothing else.
   *
   * What used to be here: a dashed arc through the whole predicted flight, a
   * 1 m landing ring, a 3 m cross through it, and a second ring starting 4.6 m
   * out and collapsing onto the first to encode arrival time. Four marks, all
   * on the frame's focal point, all fighting the disc — and the disc is the
   * subject of every gameplay framing in `docs/art-direction.md`. The arc
   * duplicated what a moving disc already shows; the cross and the collapsing
   * ring were answering a question ("when") that the disc's own visible motion
   * answers better than any annotation can. The ring stays because *where*
   * genuinely is not on the frame yet.
   */
  private drawLanding(f: HudFrame): void {
    const land = f.landing;
    if (!land.active || f.discMode !== 'flight') { setShown(this.gLand, false); return; }
    const d = this.groundRing(land.x, land.z, land.y + 0.02, LAND_R, this.pb, 0, 1);
    if (!d) { setShown(this.gLand, false); return; }
    setShown(this.gLand, true);
    this.landMark.set(d, 1.9 * this.scale);
  }

  /* ------------------------------------------------------- switch preview */

  /**
   * A half-strength ring under the body a held switch would hand you.
   *
   * The policy in `Switch.ts` is good and it is not obvious — it scores
   * time-to-threat, refuses to steal the mark, and skips anyone mid-layout. A
   * player who cannot see it working experiences it as the game handing them a
   * random defender. This is the whole fix: hold the button, steer, watch the
   * answer move. It exists only while the button is down, which makes it the
   * most event-driven mark in the layer and the easiest one to justify.
   */
  private drawSwitchPreview(f: HudFrame): void {
    const t = f.switchPreviewId >= 0 ? this.src.player(f.switchPreviewId) : null;
    this.ghostIn.target = t ? 1 : 0;
    const vis = this.ghostIn.step(f.dt);
    if (!t || vis < 0.02) { setShown(this.gGhost, false); return; }
    const d = this.groundRing(t.x, t.z, t.groundY + 0.015, RING_R, this.pb3, 0, 1);
    if (!d) { setShown(this.gGhost, false); return; }
    setShown(this.gGhost, true);
    this.ghostRing.set(d, 2.0 * this.scale);
    setStyle(this.gGhost, 'opacity', (vis * 0.52).toFixed(3));
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
   *
   * It also now carries the whole stall story on the field. There used to be a
   * ground gauge under the reset handler from stall 4, drawing the same number
   * the scorebug ring draws, in a different visual language, three metres from a
   * control ring that is also a circle. Two gauges for one number is how a HUD
   * manufactures a disagreement; the bracket appearing at 7 says the one thing
   * the count actually changes — where the disc is going.
   */
  private drawReceiver(f: HudFrame): void {
    // Only while *you* are the one holding it. `Hud.ts` resolves the bracket as
    // `selectedReceiverId(controlledId)`, which keeps answering after the throw
    // has gone — and `shots/r6-ui/live-04.png` shows what that looks like: the
    // disc is mid-flight travelling left to the body under the selection ring,
    // and the bracket is sitting on a player thirty metres to the right who is
    // not getting it. A bracket is a statement about an aim; once the disc is in
    // the air the aim is spent and the landing ring is the honest mark.
    const mine = f.discMode === 'held' && f.throwerId >= 0 && f.throwerId === f.controlledId;
    const r = mine && f.receiverId >= 0 ? this.src.player(f.receiverId) : null;
    if (!r) { setShown(this.gRecv, false); return; }
    const d = this.bracketPath(r, this.pb, 1);
    if (!d) { setShown(this.gRecv, false); return; }
    this.recvBrackets.set(d, (f.receiverAuto ? 1.8 : 2.3) * this.scale);
    this.recvBrackets.colour(f.receiverAuto ? INK_RECV_AUTO : INK_RECV);
    this.recvBrackets.dash(f.receiverAuto ? '5 4' : 'none');
    setShown(this.gRecv, true);
  }

  /**
   * Four corner brackets around an athlete, sized by their projected height —
   * a full box would read as a debug AABB.
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

  /* -------------------------------------------------------------- possession */

  /**
   * A small hollow disc glyph over the carrier's head, and only over someone
   * else's.
   *
   * The previous version drew a filled gold ellipse 17 px across with a stem
   * under it, stacked directly above the selection caret whenever the human had
   * the disc. Photographed, that is a high-contrast broadcast graphic sitting
   * two metres above a 6 px grey disc — a critic reading the frames said the
   * marker had become the thing they tracked *instead of* the disc, and they
   * were right. Another agent is making the disc itself readable; this gets out
   * of its way. Hollow, neutral, two thirds alpha, and suppressed entirely when
   * the carrier is the athlete you are driving — in that frame the caret already
   * points at the body and the disc is in its hand.
   */
  private drawCarrier(f: HudFrame): void {
    const carrier = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    if (!carrier || f.discMode !== 'held' || carrier.id === f.controlledId) {
      setShown(this.gCarrier, false);
      return;
    }
    if (!this.proj.at(carrier.x, carrier.groundY + 2.3, carrier.z)) {
      setShown(this.gCarrier, false);
      return;
    }
    setShown(this.gCarrier, true);
    const s = this.scale;
    const cx = this.proj.x.toFixed(1); const cy = this.proj.y.toFixed(1);
    const rx = (5.6 * s).toFixed(1); const ry = (2.5 * s).toFixed(1);
    for (const n of [this.carrierCase, this.carrierDisc]) {
      setAttr(n, 'cx', cx); setAttr(n, 'cy', cy);
      setAttr(n, 'rx', rx); setAttr(n, 'ry', ry);
    }
    setAttr(this.carrierCase, 'stroke-width', (1.6 * s + 2.0).toFixed(2));
    setAttr(this.carrierDisc, 'stroke-width', (1.6 * s).toFixed(2));
  }

  /* ------------------------------------------------------------- selection */

  /**
   * The athlete you are driving.
   *
   * The most damaging thing either critic said about this layer was that they
   * could not tell which player they controlled — the ring was within a few RGB
   * of every other overlay, and on the frame right after a turnover it was not
   * on the visible field at all. Three answers, in order of how much they buy:
   *
   * 1. **Deletion.** Most of the confusion was that seven near-white marks were
   *    competing. Six of them are gone.
   * 2. **A hue of its own,** and the layer's heaviest casing. See the header for
   *    the measured ratios; the short version is that the mark carries its own
   *    dark ground, so it holds against sunlit turf *and* against a white kit.
   * 3. **It is never off-frame.** If the body projects outside the viewport — or
   *    behind the camera, which is what a turnover does when the director is
   *    still swinging — a chevron clamps to the frame edge and points at it.
   *    This is the fix for "absent from the visible field": there is no camera
   *    state in which the player is left with nothing to look for.
   */
  private drawSelection(f: HudFrame): void {
    const me = f.controlledId >= 0 ? this.src.player(f.controlledId) : null;
    if (!me) { setShown(this.gSel, false); return; }
    setShown(this.gSel, true);

    // A possession flip announces itself on the body before control moves: the
    // situation has inverted around you and you are still standing in it.
    if (f.flipAt >= 0 && f.flipAt !== this.lastFlip) {
      this.lastFlip = f.flipAt;
      this.pulse.fire(f.t, PULSE_TIME);
    }
    const pp = this.pulse.peek(f.t);
    // Ease out rather than a bounce: a turnover is a hard beat, not a wobble, so
    // the ring snaps to 1.4× and settles back once.
    const grow = pp < 1 ? 1 + PULSE_GAIN * (1 - easeOut(pp)) : 1;
    if (pp >= 1) this.pulse.progress(f.t);
    const r = RING_R * grow;

    const w = this.ctx.width; const h = this.ctx.height;
    const onFrame = this.proj.at(me.x, me.groundY + 1.1, me.z)
      && this.proj.x > -40 && this.proj.x < w + 40
      && this.proj.y > -40 && this.proj.y < h + 40;

    if (!onFrame) {
      this.drawEdgeCue(me, w, h);
      this.selTrack.clear();
      this.selOuter.clear();
      this.selTether.clear();
      setAttr(this.selFill, 'd', '');
      setShown(this.selCaret, false);
      setShown(this.selCaretCase, false);
      setStyle(this.gSel, 'opacity', '1');
      return;
    }
    setShown(this.selEdge, false);
    setShown(this.selEdgeCase, false);

    // Start the arc on the far side of the ring so its gap sits behind the
    // athlete rather than across his shins.
    const cam = this.ctx.camera.position;
    const away = Math.atan2(me.x - cam.x, me.z - cam.z);

    // A ring whose far side clips the near plane is dropped on its own rather
    // than taking the group down with it. The caret is the mark that answers
    // "where am I", and it must not be collateral damage from a ground shape
    // failing to project.
    const rw = 2.8 * this.scale;
    const track = this.groundRing(me.x, me.z, me.groundY + 0.015, r, this.pb, 0, 1, away);
    this.stamina.target = clamp01(me.stamina);
    const st = this.stamina.step(f.dt);
    if (track) {
      this.selTrack.set(track, rw);
      const fill = this.groundRing(me.x, me.z, me.groundY + 0.02, r, this.pb2, 0, st, away);
      setAttr(this.selFill, 'd', fill);
      setAttr(this.selFill, 'stroke', st > 0.55 ? INK_SEL : st > 0.28 ? INK_STAM_LOW : INK_STAM_CRIT);
      setAttr(this.selFill, 'stroke-width', rw.toFixed(2));
    } else {
      this.selTrack.clear();
      setAttr(this.selFill, 'd', '');
    }

    // Recovery: the *ground* marks drop to 45 % while the body cannot act. A
    // layout costs 2.04 s and the player has to be told they are paying it — an
    // avatar that simply stops answering the stick reads as a dropped input,
    // which is the single most corrosive thing a controller can do.
    //
    // The caret does not dim with them, and that distinction is the whole point.
    // The previous version faded the entire group, and `shots/r6-ui/live-01.png`
    // caught it: `available` is false through the catch animation, so the one
    // mark answering "which of these fourteen bodies am I" was at 40 % on the
    // exact frame a turnover had just moved control to a body the player had
    // never been driving. "You cannot act yet" is worth saying quietly; "you are
    // here" is not.
    const dim = me.available ? 1 : 0.45;
    this.selTrack.opacity(dim);
    setStyle(this.selFill, 'opacity', dim.toFixed(2));
    setStyle(this.gSel, 'opacity', '1');

    /**
     * Defence: an outer ring at 0.98 m. Not a hue change — and now not always a
     * whole ring either.
     *
     * The two defensive jobs have different controls, and a control scheme
     * whose mode is invisible is one the player has to discover by pressing
     * things and watching what happens. So the ring says which one you hold,
     * in the only vocabulary this layer has: shape.
     *
     * Guarding a cutter draws the full ring — you are responsible all the way
     * round a man. ON THE DISC IT COLLAPSES TO A HALF-ARC ON THE BREAK SIDE:
     * the half you are taking away, centred on the same bearing the force arc
     * over the thrower is centred on. That is one glyph doing two jobs, because
     * it names the context and the force together, and they are the same fact —
     * holding the mark IS holding that side.
     */
    const onDefence = f.possession !== null && me.team !== f.possession;
    this.defenceIn.target = onDefence ? 1 : 0;
    const dv = this.defenceIn.step(f.dt);
    if (dv > 0.02 && track) {
      const marking = f.defenceRole === 'mark' && f.forceKnown;
      const outer = marking
        ? this.groundRing(me.x, me.z, me.groundY + 0.01, DEFENCE_RING_R * grow,
          this.pb3, 0, 0.5, f.forceAngle - Math.PI / 2)
        : this.groundRing(me.x, me.z, me.groundY + 0.01, DEFENCE_RING_R * grow,
          this.pb3, 0, 1, away);
      this.selOuter.set(outer, (marking ? 2.3 : 1.6) * this.scale);
      this.selOuter.opacity(dv * dim);
    } else {
      this.selOuter.clear();
    }

    // The caret, over the head, tethered to the crown. Filled, cased, and the
    // only filled glyph the layer draws: a ground ring can be lost in a knot of
    // bodies, and the air above a skull is the one place on the frame nothing
    // else is.
    //
    // The tether is not decoration. At 2.25 m and a 20° camera elevation the
    // caret projects some 55 px above the ring and about 11 px inboard of it,
    // and in `shots/r6-ui/live-04.png` that put the tip squarely on the head of
    // a *different* athlete standing behind the one the ring was under — a mark
    // that names the wrong body is worse than no mark. Dropping the anchor to
    // 2.08 m and running a short stem down to 1.9 m welds the two halves into
    // one glyph, so the pairing is drawn rather than inferred.
    if (this.proj.at(me.x, me.groundY + 2.08, me.z)) {
      const s = 9.5 * this.scale;
      const x = this.proj.x; const y = this.proj.y;
      const p = this.pb.reset();
      p.move(x - s, y - s * 0.92).line(x, y + s * 0.6).line(x + s, y - s * 0.92)
        .line(x, y - s * 0.45).close();
      const d = p.build();
      setAttr(this.selCaret, 'd', d);
      setAttr(this.selCaretCase, 'd', d);
      setShown(this.selCaret, true);
      setShown(this.selCaretCase, true);
      const tipY = y + s * 0.6;
      if (this.proj.at(me.x, me.groundY + 1.9, me.z) && this.proj.y > tipY + 1) {
        const q = this.pb2.reset();
        q.move(x, tipY).line(this.proj.x, this.proj.y);
        this.selTether.set(q.build(), 1.7 * this.scale);
      } else {
        this.selTether.clear();
      }
    } else {
      setShown(this.selCaret, false);
      setShown(this.selCaretCase, false);
      this.selTether.clear();
    }
  }

  /**
   * A chevron pinned to the frame edge, pointing at an athlete who is not on it.
   *
   * `Projector.toward` keeps the direction correct even when the body is behind
   * the camera, so this is the mark that makes "I cannot find my player"
   * impossible rather than merely unlikely.
   */
  private drawEdgeCue(me: { x: number; z: number; groundY: number }, w: number, h: number): void {
    this.proj.toward(me.x, me.groundY + 1.1, me.z);
    const cx = w * 0.5; const cy = h * 0.5;
    let dx = this.proj.x - cx; let dy = this.proj.y - cy;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-3)) { setShown(this.selEdge, false); setShown(this.selEdgeCase, false); return; }
    dx /= len; dy /= len;
    // Scale the ray until it hits the inset frame rectangle.
    const mx = cx - 34; const my = cy - 34;
    const k = Math.min(
      Math.abs(dx) > 1e-4 ? mx / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-4 ? my / Math.abs(dy) : Infinity,
    );
    const ex = cx + dx * k; const ey = cy + dy * k;
    const s = 11 * this.scale;
    // A triangle pointing along (dx,dy), with a notched tail so it reads as an
    // arrow rather than as a stray kit number.
    const px = -dy; const py = dx;
    const p = this.pb.reset();
    p.move(ex + dx * s, ey + dy * s)
      .line(ex - dx * s * 0.75 + px * s * 0.8, ey - dy * s * 0.75 + py * s * 0.8)
      .line(ex - dx * s * 0.3, ey - dy * s * 0.3)
      .line(ex - dx * s * 0.75 - px * s * 0.8, ey - dy * s * 0.75 - py * s * 0.8)
      .close();
    const d = p.build();
    setAttr(this.selEdge, 'd', d);
    setAttr(this.selEdgeCase, 'd', d);
    setShown(this.selEdge, true);
    setShown(this.selEdgeCase, true);
  }

  /* ------------------------------------------------------------- throw meter */

  /**
   * The power meter, which is now a prompt rather than a fixture.
   *
   * Three faults, one cause. It was byte-identical across 12.5 s of capture and
   * two possession changes; it then faded out with no state change a viewer
   * could name; and it sat dead-centre-bottom. All three follow from arming it
   * on possession and leaving it there — a panel that is always up and almost
   * never changing is indistinguishable from a panel that has stopped working,
   * and the frames prove it, because that is exactly how a critic read it.
   *
   * So: it arrives when the disc arrives, holds `METER_ARM` seconds — long
   * enough to place the perfect window before your first press — and retires.
   * Any press brings it straight back and it stays for the whole charge, where
   * every element on it is moving. It is never on screen without carrying
   * something, so it can never read as frozen.
   */
  private drawMeter(f: HudFrame): void {
    const armed = f.controlledId >= 0 && f.throwerId === f.controlledId && f.discMode === 'held';
    if (armed && !this.wasArmed) this.armClip.fire(f.t, METER_ARM + METER_ARM_FADE);
    this.wasArmed = armed;
    if (!armed) this.armClip.stop();

    const ap = this.armClip.peek(f.t);
    if (ap >= 1) this.armClip.progress(f.t);
    const prompting = this.armClip.running && ap < 1;
    // The prompt dims out over its last half-second so the retirement is a
    // decision the eye can follow rather than a disappearance.
    const promptGain = prompting
      ? (ap <= METER_ARM / (METER_ARM + METER_ARM_FADE)
        ? 1 : 1 - (ap - METER_ARM / (METER_ARM + METER_ARM_FADE)) / (METER_ARM_FADE / (METER_ARM + METER_ARM_FADE)))
      : 0;

    const want = armed && (f.charging || prompting);
    this.meterIn.target = want ? 1 : 0;
    const vis = this.meterIn.step(f.dt);
    if (vis < 0.005 && !want) { setShown(this.meter, false); return; }
    setShown(this.meter, true);

    const e = easeOut(vis);
    setStyle(this.meter, 'transform',
      `translate3d(0,${((1 - e) * 1.6).toFixed(3)}em,0) scale(${(0.96 + 0.04 * e).toFixed(4)})`);
    setStyle(this.meter, 'opacity', (e * (f.charging ? 1 : 0.85 * promptGain)).toFixed(3));

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
    setStyle(this.mBand, 'opacity', f.charging ? '1' : '0.5');
    setStyle(this.mCaret, 'opacity', f.charging ? '1' : '0.5');

    setText(this.mType, f.chargeType);
    setText(this.mQual, f.charging ? qualityWord(f.chargeQuality) : 'Ready');
    // An idle meter reporting "0%" reads as a live measurement that happens to be
    // zero. An em dash reads as "not yet", which is what it means.
    setText(this.mPower, f.charging || pw > 0.004 ? `${Math.round(pw * 100)}%` : '—');
    void this.brands;
  }

  /* ----------------------------------------------------------- geometry glue */

  /** Append one ground segment. False when either end is behind the camera. */
  private seg(p: PathBuilder, x0: number, z0: number, x1: number, z1: number, y: number): boolean {
    if (!this.proj.at(x0, y, z0)) return false;
    const sx = this.proj.x; const sy = this.proj.y;
    if (!this.proj.at(x1, y, z1)) return false;
    p.move(sx, sy).line(this.proj.x, this.proj.y);
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
