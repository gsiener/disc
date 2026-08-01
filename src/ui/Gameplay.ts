/**
 * The gameplay layer: everything that is anchored to the world rather than to
 * the frame, plus the throw meter.
 *
 * Two rules keep this from wrecking the picture. First, it is **thin, cool and
 * unsaturated** — the art direction reserves saturation for the kits and the
 * disc, so the gizmos are 1.5–2 px strokes of near-white with a single team-hue
 * tint on the ring, never filled shapes. Second, nothing here is drawn unless it
 * carries information *right now*: the flight arc only exists while the disc is
 * in the air, the receiver bracket only while a receiver is selected, the ring
 * only on the athlete the human is actually driving.
 *
 * The world-anchored shapes are true projections, not billboards: the ground
 * ring is 40 world points run through the camera and joined, so it sits on the
 * turf in perspective and foreshortens correctly as the camera drops. The flight
 * arc is sampled from `DiscPhysics` through the disc system's own `predictPath`,
 * so it is the trajectory the disc will actually fly — including the curve a
 * banked release puts on it — rather than a drawn parabola.
 *
 * ## The off-ball legibility layer
 *
 * Ultimate reads as stack, force, cutter lanes and dump resets the way football
 * reads as lines and width. Three of those four are already on screen: the AI
 * holds the shape and the camera guarantees it is framed, so fourteen bodies
 * genuinely do show you the stack, the lanes and where the reset is standing.
 * **The force does not show.** It is a rule the defence is enforcing with body
 * position, and a newcomer watching a marker shuffle cannot recover it. So it
 * gets an arc, and it is the single most valuable mark this file draws.
 *
 * The rest of the layer follows the same test — *annotate only what the
 * geometry cannot say*:
 *
 *   force arc        the break shoulder, 130° at 1.1 m, flips when the call does
 *   landing ring     where the disc comes down: the defensive read, and the
 *                    thing that makes the switch policy's choice explicable
 *   cut ghost        the order you gave, dashed, so you can judge the execution
 *   dump bracket     at stall 7 the reset stops being an option and is marked
 *   defence ring     a dashed outer ring, never a hue change
 *   recovery dim     40% while the body cannot act — the layout's 2.04 s bill
 *   switch preview   a 40% ghost under the body a held switch would hand you
 *
 * Every one of them is stroke-only, ground-projected and desaturated, because
 * the art direction spends its saturation on the two kits and the disc and this
 * layer sits on top of all three of them. Nothing here is ever a filled shape,
 * and nothing here is drawn while it is not carrying information.
 */

import * as THREE from 'three';

import type { Ctx } from '../core/Ctx.ts';
import {
  Clip, Motion, PathBuilder, clamp01, easeOut, el,
  setAttr, setShown, setStyle, setText, svgEl,
} from './Dom.ts';
import type { HudFrame, HudSource, HudWidget, TeamBrand } from './Model.ts';

const RING_SEGMENTS = 40;
const _v = new THREE.Vector3();

/* --------------------------------------------------------------- geometry */

/** Radius of the ring under the controlled player, metres. */
const RING_R = 0.62;
/** The dashed outer ring that says "defending". Never a colour change. */
const DEFENCE_RING_R = 1.05;
/** Force arc: 130° of a 1.1 m circle centred on the break shoulder. */
const FORCE_R = 1.1;
const FORCE_SPAN = (130 * Math.PI) / 180;
/** Seconds a released cut order stays on the turf before it is gone. */
const CUT_FADE = 1.5;
/** Turnover pulse: 1.4× radius, 0.3 s. */
const PULSE_TIME = 0.3;
const PULSE_GAIN = 0.4;

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

export class GameplayLayer implements HudWidget {
  readonly svg: SVGSVGElement;
  readonly meter: HTMLElement;

  private ctx: Ctx;
  private src: HudSource;
  private brands: [TeamBrand, TeamBrand];
  private proj: Projector;

  /* world gizmos */
  private gRing: SVGGElement;
  private ringTrack: SVGPathElement;
  private ringFill: SVGPathElement;
  private ringChevron: SVGPathElement;
  private ringOuter: SVGPathElement;
  private gCarrier: SVGGElement;
  private carrierDisc: SVGEllipseElement;
  private carrierStem: SVGPathElement;
  private gRecv: SVGGElement;
  private recvBrackets: SVGPathElement;
  private gFlight: SVGGElement;
  private flightLine: SVGPathElement;
  private flightGlow: SVGPathElement;
  private landRing: SVGPathElement;
  private landCross: SVGPathElement;
  private gForce: SVGGElement;
  private forceArc: SVGPathElement;
  private forceCaps: SVGPathElement;
  private gCut: SVGGElement;
  private cutLine: SVGPathElement;
  private cutHead: SVGPathElement;
  private gDump: SVGGElement;
  private dumpBrackets: SVGPathElement;
  private gGhost: SVGGElement;
  private ghostRing: SVGPathElement;

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
   * marker makes when they change the call. At rate 11 the swing takes about a
   * quarter of a second, which is long enough to see and short enough that the
   * arc is never lying about the current call for a meaningful length of time.
   */
  private forceAngle = new Motion(0, 11);
  private forceHas = false;
  private defenceIn = new Motion(0, 8);
  private dumpIn = new Motion(0, 10);
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

    /* --- the force ------------------------------------------------------- */
    // Drawn first, so every body-anchored mark sits over it. It is structure,
    // not a callout.
    this.gForce = svgEl('g', undefined, this.svg);
    this.forceArc = svgEl('path', undefined, this.gForce);
    this.forceCaps = svgEl('path', undefined, this.gForce);
    stroke(this.forceArc, 'rgba(203,222,246,.70)', 2.2);
    setAttr(this.forceArc, 'stroke-linecap', 'round');
    stroke(this.forceCaps, 'rgba(203,222,246,.42)', 1.6);
    setShown(this.gForce, false);

    /* --- commanded cut --------------------------------------------------- */
    this.gCut = svgEl('g', undefined, this.svg);
    this.cutLine = svgEl('path', undefined, this.gCut);
    this.cutHead = svgEl('path', undefined, this.gCut);
    stroke(this.cutLine, 'rgba(198,219,244,.78)', 1.8);
    setAttr(this.cutLine, 'stroke-dasharray', '7 6');
    setAttr(this.cutLine, 'stroke-linecap', 'round');
    stroke(this.cutHead, 'rgba(198,219,244,.78)', 1.8);
    setShown(this.gCut, false);

    /* --- predicted flight ------------------------------------------------ */
    this.gFlight = svgEl('g', undefined, this.svg);
    this.flightGlow = svgEl('path', undefined, this.gFlight);
    this.flightLine = svgEl('path', undefined, this.gFlight);
    this.landRing = svgEl('path', undefined, this.gFlight);
    this.landCross = svgEl('path', undefined, this.gFlight);
    stroke(this.flightGlow, 'rgba(255,255,255,.10)', 7);
    stroke(this.flightLine, 'rgba(246,250,255,.72)', 2);
    setAttr(this.flightLine, 'stroke-dasharray', '9 7');
    stroke(this.landRing, 'rgba(246,250,255,.62)', 1.8);
    stroke(this.landCross, 'rgba(246,250,255,.40)', 1.4);
    setShown(this.gFlight, false);

    /* --- switch preview --------------------------------------------------- */
    this.gGhost = svgEl('g', undefined, this.svg);
    this.ghostRing = svgEl('path', undefined, this.gGhost);
    stroke(this.ghostRing, 'rgba(232,242,255,.92)', 2.0);
    setAttr(this.ghostRing, 'stroke-dasharray', '5 5');
    setShown(this.gGhost, false);

    /* --- controlled player ----------------------------------------------- */
    this.gRing = svgEl('g', undefined, this.svg);
    this.ringOuter = svgEl('path', undefined, this.gRing);
    this.ringTrack = svgEl('path', undefined, this.gRing);
    this.ringFill = svgEl('path', undefined, this.gRing);
    this.ringChevron = svgEl('path', undefined, this.gRing);
    // On defence the ring gains an outer dashed circle rather than a hue: the
    // two kits and the disc own every saturated pixel in the frame, and a HUD
    // that starts colouring itself by game state takes that back one element at
    // a time. A broken outline reads as "contesting" without spending any.
    stroke(this.ringOuter, 'rgba(224,238,255,.55)', 1.5);
    setAttr(this.ringOuter, 'stroke-dasharray', '4 6');
    stroke(this.ringTrack, 'rgba(232,242,255,.20)', 2.4);
    stroke(this.ringFill, 'rgba(232,242,255,.92)', 2.4);
    setAttr(this.ringFill, 'stroke-linecap', 'round');
    setAttr(this.ringChevron, 'fill', 'rgba(240,247,255,.94)');
    setAttr(this.ringChevron, 'stroke', 'none');
    setShown(this.gRing, false);

    /* --- carrier --------------------------------------------------------- */
    this.gCarrier = svgEl('g', undefined, this.svg);
    this.carrierStem = svgEl('path', undefined, this.gCarrier);
    this.carrierDisc = svgEl('ellipse', undefined, this.gCarrier);
    stroke(this.carrierStem, 'rgba(244,198,87,.45)', 1.4);
    setAttr(this.carrierDisc, 'fill', 'rgba(244,198,87,.92)');
    setAttr(this.carrierDisc, 'stroke', 'rgba(20,16,6,.35)');
    setAttr(this.carrierDisc, 'stroke-width', '1');
    setShown(this.gCarrier, false);

    /* --- receiver -------------------------------------------------------- */
    this.gRecv = svgEl('g', undefined, this.svg);
    this.recvBrackets = svgEl('path', undefined, this.gRecv);
    stroke(this.recvBrackets, 'rgba(139,236,190,.88)', 2.2);
    setAttr(this.recvBrackets, 'stroke-linecap', 'square');
    setShown(this.gRecv, false);

    /* --- the reset, once the count says so -------------------------------- */
    // Same family as the receiver bracket because it means the same thing —
    // "this is the throw" — but broken and dimmer, because the game suggested
    // it and the player did not choose it.
    this.gDump = svgEl('g', undefined, this.svg);
    this.dumpBrackets = svgEl('path', undefined, this.gDump);
    stroke(this.dumpBrackets, 'rgba(139,236,190,.62)', 1.9);
    setAttr(this.dumpBrackets, 'stroke-linecap', 'butt');
    setAttr(this.dumpBrackets, 'stroke-dasharray', '5 4');
    setShown(this.gDump, false);

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
    this.scale = Math.max(0.72, Math.min(1.35, w / 1920));
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
    this.defenceIn.set(0);
    this.dumpIn.set(0);
    this.ghostIn.set(0);
    this.pulse.stop();
    this.lastFlip = f.flipAt;
  }

  /* ------------------------------------------------------------------ frame */

  update(f: HudFrame): void {
    this.drawForce(f);
    this.drawCut(f);
    this.drawFlight(f);
    this.drawSwitchPreview(f);
    this.drawControlled(f);
    this.drawCarrier(f);
    this.drawReceiver(f);
    this.drawDump(f);
    this.drawMeter(f);
  }

  /* -------------------------------------------------------------- the force */

  /**
   * A 130° arc at 1.1 m on the thrower's break side.
   *
   * This is the one annotation a newcomer genuinely cannot infer from watching
   * bodies. Everything else the HUD marks is visible if you know where to look
   * — the stack is a column, the reset is the player standing behind the disc,
   * a cut is somebody running. The force is a *rule the defence is imposing*,
   * expressed as one defender standing four feet off one shoulder, and no
   * amount of watching recovers it. So it gets the arc: the shoulder that is
   * closed, drawn on the turf at the radius the mark actually occupies, wide
   * enough (130°) to read as a wall rather than a pointer.
   */
  private drawForce(f: HudFrame): void {
    this.forceIn.target = f.forceKnown ? 1 : 0;
    const vis = this.forceIn.step(f.dt);
    const thrower = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
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
    const span = FORCE_SPAN / (Math.PI * 2);
    const d = this.groundRing(thrower.x, thrower.z, y, FORCE_R, this.pb, 0, span, a - FORCE_SPAN / 2);
    if (!d) { setShown(this.gForce, false); return; }
    setShown(this.gForce, true);
    setAttr(this.forceArc, 'd', d);
    setAttr(this.forceArc, 'stroke-width', (2.2 * this.scale).toFixed(2));
    setStyle(this.gForce, 'opacity', (vis * 0.92).toFixed(3));

    // Two short radial ticks turning in at the ends. Without them the arc reads
    // as a stray curve on the grass; with them it reads as a closed side.
    const p = this.pb2.reset();
    let ok = true;
    for (const s of [-1, 1]) {
      const e = a + (s * FORCE_SPAN) / 2;
      const sx = Math.sin(e), sz = Math.cos(e);
      if (!this.proj.at(thrower.x + sx * FORCE_R, y, thrower.z + sz * FORCE_R)) { ok = false; break; }
      p.move(this.proj.x, this.proj.y);
      if (!this.proj.at(thrower.x + sx * (FORCE_R - 0.30), y, thrower.z + sz * (FORCE_R - 0.30))) { ok = false; break; }
      p.line(this.proj.x, this.proj.y);
    }
    setAttr(this.forceCaps, 'd', ok ? p.build() : '');
    setAttr(this.forceCaps, 'stroke-width', (1.6 * this.scale).toFixed(2));
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
    setAttr(this.cutLine, 'd', p.build());
    setAttr(this.cutLine, 'stroke-width', (1.8 * this.scale).toFixed(2));
    setStyle(this.gCut, 'opacity', (alpha * 0.85).toFixed(3));

    // A small open ring on the target — the space, not a point.
    const head = this.groundRing(c.targetX, c.targetZ, y, 0.55, this.pb2, 0, 1);
    setAttr(this.cutHead, 'd', head);
    setAttr(this.cutHead, 'stroke-width', (1.8 * this.scale).toFixed(2));
  }

  /* ------------------------------------------------------- switch preview */

  /**
   * A 40 %-opacity ring under the body a held switch would hand you.
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
    setAttr(this.ghostRing, 'd', d);
    setAttr(this.ghostRing, 'stroke-width', (2.0 * this.scale).toFixed(2));
    setStyle(this.gGhost, 'opacity', (vis * 0.40).toFixed(3));
  }

  /* ------------------------------------------------------------- the reset */

  private drawDump(f: HudFrame): void {
    // Suppressed the moment the reset is the actual selection: two brackets on
    // one body, one solid and one dashed, is noise pretending to be nuance.
    const want = f.dumpId >= 0 && f.dumpId !== f.receiverId ? this.src.player(f.dumpId) : null;
    this.dumpIn.target = want ? 1 : 0;
    const vis = this.dumpIn.step(f.dt);
    if (!want || vis < 0.02) { setShown(this.gDump, false); return; }
    const d = this.bracketPath(want, this.pb3, 0.92);
    if (!d) { setShown(this.gDump, false); return; }
    setShown(this.gDump, true);
    setAttr(this.dumpBrackets, 'd', d);
    setAttr(this.dumpBrackets, 'stroke-width', (1.9 * this.scale).toFixed(2));
    setStyle(this.gDump, 'opacity', vis.toFixed(3));
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
    const d = p.build();
    setShown(this.gFlight, true);
    setAttr(this.flightGlow, 'd', d);
    setAttr(this.flightLine, 'd', d);
    setAttr(this.flightGlow, 'stroke-width', (7 * this.scale).toFixed(2));
    setAttr(this.flightLine, 'stroke-width', (2 * this.scale).toFixed(2));

    // Where it comes down, drawn ON THE TURF so the eye can lead the play.
    //
    // This ring used to be centred on the last sample of a 2.4 s prediction and
    // drawn at that sample's height — which on any throw still in the air at
    // 2.4 s is a ring floating in mid-air around a point the disc flies
    // straight through. It is now the landing the flight actually resolves to
    // (`Hud.ts` integrates to ground contact) and it sits flat on the grass,
    // which is the read the defence is making: not "where is the disc" but
    // "where do I have to be, and when".
    const land = f.landing;
    if (!land.active) { setAttr(this.landRing, 'd', ''); setAttr(this.landCross, 'd', ''); return; }
    const ly = land.y + 0.02;
    const ring = this.groundRing(land.x, land.z, ly, 0.85, this.pb2, 0, 1);
    setAttr(this.landRing, 'd', ring);
    setAttr(this.landRing, 'stroke-width', (1.8 * this.scale).toFixed(2));

    // Two short axis ticks through the centre. At 40 m a 0.85 m circle is a few
    // pixels across; the cross survives the range at which the ring does not.
    const cp = this.pb3.reset();
    let ok = true;
    for (const ax of [[1, 0], [0, 1]] as const) {
      if (!this.proj.at(land.x - ax[0] * 1.35, ly, land.z - ax[1] * 1.35)) { ok = false; break; }
      cp.move(this.proj.x, this.proj.y);
      if (!this.proj.at(land.x + ax[0] * 1.35, ly, land.z + ax[1] * 1.35)) { ok = false; break; }
      cp.line(this.proj.x, this.proj.y);
    }
    setAttr(this.landCross, 'd', ok ? cp.build() : '');
    setAttr(this.landCross, 'stroke-width', (1.4 * this.scale).toFixed(2));
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
    setAttr(this.ringTrack, 'd', track);

    this.stamina.target = clamp01(me.stamina);
    const st = this.stamina.step(f.dt);
    const fill = this.groundRing(me.x, me.z, me.groundY + 0.02, r, this.pb2, 0, st, away);
    setAttr(this.ringFill, 'd', fill);
    const col = st > 0.55
      ? 'rgba(232,242,255,.92)'
      : st > 0.28 ? 'rgba(255,171,61,.95)' : 'rgba(255,95,69,.95)';
    setAttr(this.ringFill, 'stroke', col);
    const w = (2.4 * this.scale).toFixed(2);
    setAttr(this.ringTrack, 'stroke-width', w);
    setAttr(this.ringFill, 'stroke-width', w);

    // Defence: a dashed outer ring at 1.05 m. Not a hue change.
    const onDefence = f.possession !== null && me.team !== f.possession;
    this.defenceIn.target = onDefence ? 1 : 0;
    const dv = this.defenceIn.step(f.dt);
    if (dv > 0.02) {
      const outer = this.groundRing(
        me.x, me.z, me.groundY + 0.01, DEFENCE_RING_R * grow, this.pb3, 0, 1, away,
      );
      setAttr(this.ringOuter, 'd', outer);
      setAttr(this.ringOuter, 'stroke-width', (1.5 * this.scale).toFixed(2));
      setStyle(this.ringOuter, 'opacity', dv.toFixed(3));
      setShown(this.ringOuter, true);
    } else {
      setShown(this.ringOuter, false);
    }

    // Recovery: 40 % while the body cannot act. A layout costs 2.04 s and the
    // player has to be told they are paying it — an avatar that simply stops
    // answering the stick reads as a dropped input, which is the single most
    // corrosive thing a controller can do.
    setStyle(this.gRing, 'opacity', me.available ? '1' : '0.4');

    // Control chevron, floating a little over the head.
    if (this.proj.at(me.x, me.groundY + 2.16, me.z)) {
      const s = 7 * this.scale;
      const x = this.proj.x, y = this.proj.y;
      const p = this.pb.reset();
      p.move(x - s, y - s * 0.9).line(x, y + s * 0.55).line(x + s, y - s * 0.9).close();
      setAttr(this.ringChevron, 'd', p.build());
      setShown(this.ringChevron, true);
    } else {
      setShown(this.ringChevron, false);
    }
  }

  /* -------------------------------------------------------------- possession */

  private drawCarrier(f: HudFrame): void {
    const carrier = f.throwerId >= 0 ? this.src.player(f.throwerId) : null;
    if (!carrier || f.discMode !== 'held' || carrier.id === f.controlledId) {
      setShown(this.gCarrier, false);
      return;
    }
    if (!this.proj.at(carrier.x, carrier.groundY + 2.34, carrier.z)) {
      setShown(this.gCarrier, false);
      return;
    }
    setShown(this.gCarrier, true);
    const s = this.scale;
    setAttr(this.carrierDisc, 'cx', this.proj.x.toFixed(1));
    setAttr(this.carrierDisc, 'cy', this.proj.y.toFixed(1));
    setAttr(this.carrierDisc, 'rx', (7 * s).toFixed(1));
    setAttr(this.carrierDisc, 'ry', (3.1 * s).toFixed(1));
    const p = this.pb.reset();
    p.move(this.proj.x, this.proj.y + 4 * s).line(this.proj.x, this.proj.y + 11 * s);
    setAttr(this.carrierStem, 'd', p.build());
  }

  /* ---------------------------------------------------------------- receiver */

  private drawReceiver(f: HudFrame): void {
    const r = f.receiverId >= 0 ? this.src.player(f.receiverId) : null;
    if (!r) { setShown(this.gRecv, false); return; }
    const d = this.bracketPath(r, this.pb, 1);
    if (!d) { setShown(this.gRecv, false); return; }
    setAttr(this.recvBrackets, 'd', d);
    setAttr(this.recvBrackets, 'stroke-width', (2.2 * this.scale).toFixed(2));
    setShown(this.gRecv, true);
  }

  /**
   * Four corner brackets around an athlete, sized by their projected height —
   * a full box would read as a debug AABB. `k` scales the box so a suggestion
   * can sit inside a selection without the two fighting.
   */
  private bracketPath(r: { x: number; z: number; groundY: number }, pb: PathBuilder, k: number): string {
    if (!this.proj.at(r.x, r.groundY + 0.98, r.z)) return '';
    const cx = this.proj.x, cy = this.proj.y;
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

  /* ------------------------------------------------------------------ helper */

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

function stroke(node: SVGElement, colour: string, width: number): void {
  setAttr(node, 'fill', 'none');
  setAttr(node, 'stroke', colour);
  setAttr(node, 'stroke-width', String(width));
  setAttr(node, 'stroke-linejoin', 'round');
}

function qualityWord(q: number): string {
  if (q >= 0.94) return 'Perfect';
  if (q >= 0.78) return 'Clean';
  if (q >= 0.55) return 'Loose';
  return 'Rushed';
}
