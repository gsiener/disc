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
 */

import * as THREE from 'three';

import type { Ctx } from '../core/Ctx.ts';
import {
  Motion, PathBuilder, clamp01, easeOut, el, setAttr, setShown, setStyle, setText, svgEl,
} from './Dom.ts';
import type { HudFrame, HudSource, HudWidget, TeamBrand } from './Model.ts';

const RING_SEGMENTS = 40;
const _v = new THREE.Vector3();

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
  private gCarrier: SVGGElement;
  private carrierDisc: SVGEllipseElement;
  private carrierStem: SVGPathElement;
  private gRecv: SVGGElement;
  private recvBrackets: SVGPathElement;
  private gFlight: SVGGElement;
  private flightLine: SVGPathElement;
  private flightGlow: SVGPathElement;
  private landRing: SVGPathElement;

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
  private scale = 1;
  private power = new Motion(0, 26);
  private quality = new Motion(0, 18);
  private meterIn = new Motion(0, 9);
  private stamina = new Motion(1, 6);

  constructor(parent: HTMLElement, ctx: Ctx, src: HudSource, brands: [TeamBrand, TeamBrand]) {
    this.ctx = ctx;
    this.src = src;
    this.brands = brands;
    this.proj = new Projector(ctx);

    this.svg = svgEl('svg', 'ug-svg', parent);
    this.svg.setAttribute('viewBox', `0 0 ${ctx.width} ${ctx.height}`);

    /* --- predicted flight ------------------------------------------------ */
    this.gFlight = svgEl('g', undefined, this.svg);
    this.flightGlow = svgEl('path', undefined, this.gFlight);
    this.flightLine = svgEl('path', undefined, this.gFlight);
    this.landRing = svgEl('path', undefined, this.gFlight);
    stroke(this.flightGlow, 'rgba(255,255,255,.10)', 7);
    stroke(this.flightLine, 'rgba(246,250,255,.72)', 2);
    setAttr(this.flightLine, 'stroke-dasharray', '9 7');
    stroke(this.landRing, 'rgba(246,250,255,.55)', 1.8);
    setShown(this.gFlight, false);

    /* --- controlled player ----------------------------------------------- */
    this.gRing = svgEl('g', undefined, this.svg);
    this.ringTrack = svgEl('path', undefined, this.gRing);
    this.ringFill = svgEl('path', undefined, this.gRing);
    this.ringChevron = svgEl('path', undefined, this.gRing);
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
  }

  /* ------------------------------------------------------------------ frame */

  update(f: HudFrame): void {
    this.drawFlight(f);
    this.drawControlled(f);
    this.drawCarrier(f);
    this.drawReceiver(f);
    this.drawMeter(f);
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

    // Where it comes down, drawn on the turf so the eye can lead the play.
    const last = path[path.length - 1];
    const ring = this.groundRing(last.x, last.z, last.y, 0.85, this.pb2, 0, 1);
    setAttr(this.landRing, 'd', ring);
    setAttr(this.landRing, 'stroke-width', (1.8 * this.scale).toFixed(2));
  }

  /* ------------------------------------------------ controlled player + ring */

  private drawControlled(f: HudFrame): void {
    const me = f.controlledId >= 0 ? this.src.player(f.controlledId) : null;
    if (!me) { setShown(this.gRing, false); return; }

    // Start the arc on the far side of the ring so its gap sits behind the
    // athlete rather than across his shins.
    const cam = this.ctx.camera.position;
    const away = Math.atan2(me.x - cam.x, me.z - cam.z);

    const track = this.groundRing(me.x, me.z, me.groundY + 0.015, 0.62, this.pb, 0, 1, away);
    if (!track) { setShown(this.gRing, false); return; }
    setShown(this.gRing, true);
    setAttr(this.ringTrack, 'd', track);

    this.stamina.target = clamp01(me.stamina);
    const st = this.stamina.step(f.dt);
    const fill = this.groundRing(me.x, me.z, me.groundY + 0.02, 0.62, this.pb2, 0, st, away);
    setAttr(this.ringFill, 'd', fill);
    const col = st > 0.55
      ? 'rgba(232,242,255,.92)'
      : st > 0.28 ? 'rgba(255,171,61,.95)' : 'rgba(255,95,69,.95)';
    setAttr(this.ringFill, 'stroke', col);
    const w = (2.4 * this.scale).toFixed(2);
    setAttr(this.ringTrack, 'stroke-width', w);
    setAttr(this.ringFill, 'stroke-width', w);

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
    if (!this.proj.at(r.x, r.groundY + 0.98, r.z)) { setShown(this.gRecv, false); return; }
    const cx = this.proj.x, cy = this.proj.y;
    if (!this.proj.at(r.x, r.groundY + 1.96, r.z)) { setShown(this.gRecv, false); return; }
    const halfH = Math.max(14, Math.abs(cy - this.proj.y) * 1.12);
    const halfW = halfH * 0.62;
    const arm = Math.max(5, halfH * 0.3);

    const p = this.pb.reset();
    // Four corner brackets — a full box would read as a debug AABB.
    p.move(cx - halfW, cy - halfH + arm).line(cx - halfW, cy - halfH).line(cx - halfW + arm, cy - halfH);
    p.move(cx + halfW - arm, cy - halfH).line(cx + halfW, cy - halfH).line(cx + halfW, cy - halfH + arm);
    p.move(cx + halfW, cy + halfH - arm).line(cx + halfW, cy + halfH).line(cx + halfW - arm, cy + halfH);
    p.move(cx - halfW + arm, cy + halfH).line(cx - halfW, cy + halfH).line(cx - halfW, cy + halfH - arm);
    setAttr(this.recvBrackets, 'd', p.build());
    setAttr(this.recvBrackets, 'stroke-width', (2.2 * this.scale).toFixed(2));
    setShown(this.gRecv, true);
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
    setStyle(this.meter, 'opacity', (e * (f.charging ? 1 : 0.82)).toFixed(3));

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

    setText(this.mType, f.chargeType);
    setText(this.mQual, f.charging ? qualityWord(f.chargeQuality) : 'Ready');
    setText(this.mPower, `${Math.round(pw * 100)}%`);
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
