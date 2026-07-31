import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx.ts';
import {
  DISC, FIXED_DT, createDiscState, isFiniteState, renderQuaternion, simulate, throwDisc,
  type DiscState, type ThrowOptions, type ThrowType,
} from '../sim/DiscPhysics.ts';
import { bake, canvasTexture, heightField, heightToNormal } from '../util/Tex.ts';
import { clamp, fbm2, hash2, smoothstep, valueNoise2 } from '../util/Noise.ts';

/**
 * THE DISC.
 *
 * Two things live in this file.
 *
 * `DiscRuntime` is the headless half: the 6-DOF state, the flight integration,
 * the trail history and the wear ledger. It imports nothing from the renderer,
 * so `src/sim/Game.ts` can own one and `tools/test-game.ts` can run a whole
 * match without a GL context. The game system is the single driver — it decides
 * when the disc is in a hand, in the air or on the grass, and calls `step()`.
 *
 * `DiscSystem` is the visual half. It adopts the game's runtime if one exists
 * (`ctx.sys.game.discRuntime`) and otherwise owns its own, so the module is
 * still useful with the rest of the game stubbed.
 *
 * What is actually modelled, and why:
 *
 *  - A LATHED 175 g PROFILE, not a cylinder. 33 profile points sweep the real
 *    cross-section: a domed flight plate, the shoulder where the plate rolls
 *    over, an outer rim that bulges past the plate radius, the contact lip, a
 *    near-vertical inner rim wall and the inner bead where the wall meets the
 *    underside. That silhouette is 90% of why a disc reads as a disc: the
 *    shoulder catches a highlight the plate does not, and the rim throws a
 *    second, tighter specular under it.
 *  - PLANAR-POLAR UVs. Top and bottom faces each get their own circle in the
 *    texture (centres at v = 0.25 and 0.75), so the hot-stamped foil on the
 *    plate and the mould gate on the underside are separately authored, and
 *    every shader term can recover disc-space radius from `vMapUv` alone —
 *    which is what makes the rotational blur below possible without a custom
 *    attribute.
 *  - INJECTION-MOULDED PLASTIC. Concentric flow rings in the normal map from
 *    the mould, a clearcoat for the polish, and a forward-scatter term that
 *    only fires where the section is thin (the rim edge and the inner bead) —
 *    which is exactly where a real disc glows when the sun is behind it.
 *  - ROTATIONAL MOTION BLUR. At 45 rad/s the disc turns 6 degrees per 60 Hz
 *    frame; sampled once it strobes. The albedo, wear and roughness are sampled
 *    across an arc proportional to spin * frame time, so the foil smears into a
 *    ring the way it does on broadcast and the disc reads as *spinning*.
 *  - WEAR THAT ACCUMULATES. A 256^2 scuff/stain map, stamped every time the
 *    disc hits the grass, at the point of the disc that struck. By the end of a
 *    match the underside is green and the rim is scratched.
 *  - A TRAIL THAT IS THE REAL PATH. Not a spline hint — the actual sampled
 *    flight, so the curve of a huck is the curve DiscPhysics produced. Width
 *    and opacity scale with speed, so a 6 m dump has essentially none and a
 *    55 m hammer has a full ribbon.
 *  - A CONTACT SHADOW that tightens and darkens as the disc nears the turf.
 *    For a small object against a big green plane this is the depth cue.
 */

/* ========================================================== profile + mesh */

const R = DISC.diameter * 0.5;      // 0.1365 m
const H = DISC.halfHeight;          // 0.013 m

/**
 * Cross-section, as (radius / R, height / H). Traversed from the centre of the
 * flight plate, out over the shoulder, around the rim, and back in along the
 * underside. Index `SEAM` is the outer-most point and splits the top UV island
 * from the bottom one.
 */
const PROFILE: readonly (readonly [number, number])[] = [
  /* flight plate — a very slight dome, ~2 mm of crown across 27 cm */
  [0.000, 1.000],
  [0.180, 0.996],
  [0.360, 0.985],
  [0.520, 0.966],
  [0.650, 0.940],
  [0.740, 0.905],
  /* shoulder: the plate rolls over into the rim */
  [0.808, 0.855],
  [0.862, 0.780],
  [0.905, 0.680],
  [0.940, 0.545],
  [0.966, 0.380],
  [0.985, 0.190],
  [0.996, -0.030],
  [1.000, -0.300],   // <- SEAM: widest point
  /* outer rim wall down to the contact lip */
  [0.996, -0.560],
  [0.985, -0.760],
  [0.968, -0.900],
  [0.945, -0.972],
  [0.918, -1.000],   // the lip that touches the grass
  /* inner rim wall, essentially vertical */
  [0.898, -0.975],
  [0.884, -0.905],
  [0.876, -0.790],
  [0.873, -0.600],
  [0.873, -0.300],
  [0.874, 0.000],
  [0.878, 0.260],
  /* inner bead where the wall meets the plate underside */
  [0.888, 0.450],
  [0.897, 0.560],
  [0.890, 0.660],
  [0.868, 0.730],
  /* underside of the flight plate */
  [0.820, 0.780],
  [0.740, 0.805],
  [0.640, 0.818],
  [0.520, 0.826],
  [0.360, 0.831],
  [0.180, 0.834],
  [0.000, 0.836],
];
const SEAM = 13;

/** UV radius of the disc circle inside its half of the texture. */
const UVR = 0.245;

function segmentsFor(tier: string): number {
  return tier === 'low' ? 40 : tier === 'medium' ? 64 : tier === 'ultra' ? 128 : 96;
}
function tapsFor(tier: string): number {
  return tier === 'low' ? 1 : tier === 'medium' ? 3 : tier === 'ultra' ? 9 : 6;
}

/**
 * Surface of revolution about +Y, with the UV seam duplicated so the top and
 * bottom faces land in separate texture islands. +Y is the disc normal, which
 * is what `renderQuaternion()` in DiscPhysics expects.
 */
function buildDiscGeometry(seg: number): THREE.BufferGeometry {
  // Duplicate the seam row so it can carry two different UVs.
  const rows: { r: number; y: number; top: boolean }[] = [];
  for (let i = 0; i <= SEAM; i++) rows.push({ r: PROFILE[i][0] * R, y: PROFILE[i][1] * H, top: true });
  for (let i = SEAM; i < PROFILE.length; i++) rows.push({ r: PROFILE[i][0] * R, y: PROFILE[i][1] * H, top: false });

  // Profile-plane normals, averaged over the two adjacent segments.
  const pn: { r: number; y: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    let nr = 0, ny = 0;
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= rows.length) continue;
      const dr = rows[j + 1].r - rows[j].r;
      const dy = rows[j + 1].y - rows[j].y;
      const l = Math.hypot(dr, dy);
      if (l < 1e-9) continue;
      nr += dy / l;          // outward normal of (dr,dy) is (dy,-dr) rotated
      ny += -dr / l;
    }
    // The two seam rows share a position; keep the outward normal pointing out.
    const l = Math.hypot(nr, ny) || 1;
    pn.push({ r: nr / l, y: ny / l });
  }
  // Flip: our convention above yields an inward normal on the top plate.
  for (const n of pn) { n.r = -n.r; n.y = -n.y; }

  const cols = seg + 1;
  const nv = rows.length * cols;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const n = pn[i];
    const cv = row.top ? 0.25 : 0.75;
    const vs = row.top ? 1 : -1;
    const rr = Math.min(1, row.r / R);
    for (let j = 0; j < cols; j++) {
      const a = (j / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const k = (i * cols + j);
      pos[k * 3] = row.r * c;
      pos[k * 3 + 1] = row.y;
      pos[k * 3 + 2] = row.r * s;
      nor[k * 3] = n.r * c;
      nor[k * 3 + 1] = n.y;
      nor[k * 3 + 2] = n.r * s;
      uv[k * 2] = 0.5 + UVR * rr * c;
      uv[k * 2 + 1] = cv + UVR * rr * s * vs;
    }
  }

  const idx: number[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    // Skip the degenerate band that joins the two seam rows.
    if (i === SEAM) continue;
    for (let j = 0; j < seg; j++) {
      // Wound so the geometric face normal agrees with the profile normal
      // above. Get this backwards and DOUBLE_SIDED flips every shading normal
      // inward: the disc lights from behind and renders as a black ellipse.
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.name = 'disc-175g';
  return g;
}

/* ------------------------------------------------------------ texture bake */

/** Recover disc-space polar coordinates from a texture uv. */
function uvPolar(u: number, v: number): { top: boolean; rr: number; ang: number } {
  const top = v < 0.5;
  const cv = top ? 0.25 : 0.75;
  const dx = (u - 0.5) / UVR;
  const dy = ((v - cv) / UVR) * (top ? 1 : -1);
  return { top, rr: Math.hypot(dx, dy), ang: Math.atan2(dy, dx) };
}

/** Foil ring, as fractions of the disc radius. */
const FOIL_IN = 0.575, FOIL_OUT = 0.755;

/**
 * Albedo. Drawn on a 2D canvas because everything on a disc is typographic or
 * circular: an arced wordmark, a hot-stamped ring, a mould gate.
 */
function bakeAlbedo(seed: number): THREE.Texture {
  const S = 1024;
  return canvasTexture(S, S, (c) => {
    const rnd = mulberry(seed);
    c.fillStyle = '#2b2f33';
    c.fillRect(0, 0, S, S);

    const face = (cy: number, isTop: boolean) => {
      const cx = S * 0.5;
      const rad = S * UVR;

      /**
       * Base plastic.
       *
       * The art direction pins the disc at `#fafafa` and calls it "the highest
       * value object on the pitch in every daylight frame" — it is one of the
       * three things in the whole scene allowed to sing. The old ramp ran
       * `#e9edf1 → #b9bfc6`: a blue-grey that, once the rotational blur had
       * averaged it and a cool sky fill had lit it, rendered as a pale
       * blue-grey lollipop in the `disc` framing rather than a white disc.
       *
       * So: neutral hue (r = g = b within a point), and only about a fifth of
       * a stop of fall-off from plate centre to rim, which is all the shading
       * a 2 mm crown of white polyethylene actually has. The rim shadow comes
       * from the geometry and the ORM map, not from painting it grey.
       */
      const g = c.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
      g.addColorStop(0.00, isTop ? '#fbfbfa' : '#f2f2f1');
      g.addColorStop(0.62, isTop ? '#f8f8f7' : '#eeeeed');
      g.addColorStop(0.86, isTop ? '#f0f0ef' : '#e6e6e5');
      g.addColorStop(1.00, '#dcdcdb');
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.fill();

      // Injection flow rings — faint concentric banding from the mould.
      c.save();
      c.beginPath(); c.arc(cx, cy, rad, 0, Math.PI * 2); c.clip();
      for (let i = 0; i < 42; i++) {
        const t = i / 42;
        const r = rad * (0.06 + 0.92 * t);
        c.strokeStyle = `rgba(255,255,255,${0.018 + 0.020 * Math.abs(Math.sin(i * 2.1))})`;
        c.lineWidth = 1 + 2.2 * rnd();
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      }

      if (isTop) {
        // Hot-stamped foil ring. Two tones so it reads as metal leaf, not paint.
        const fg = c.createLinearGradient(cx - rad, cy - rad, cx + rad, cy + rad);
        fg.addColorStop(0.00, '#c9a349');
        fg.addColorStop(0.24, '#ffeeba');
        fg.addColorStop(0.48, '#e2b855');
        fg.addColorStop(0.72, '#fff3cd');
        fg.addColorStop(1.00, '#d0a949');
        c.strokeStyle = fg;
        c.lineWidth = rad * (FOIL_OUT - FOIL_IN) * 0.16;
        c.beginPath(); c.arc(cx, cy, rad * FOIL_OUT, 0, Math.PI * 2); c.stroke();
        c.lineWidth = rad * (FOIL_OUT - FOIL_IN) * 0.10;
        c.beginPath(); c.arc(cx, cy, rad * FOIL_IN, 0, Math.PI * 2); c.stroke();

        // Arced wordmark inside the ring.
        c.fillStyle = fg;
        arcText(c, cx, cy, rad * 0.685, 'U L T I M A T E   S E R I E S', -Math.PI / 2, rad * 0.115, 1);
        arcText(c, cx, cy, rad * 0.625, '1 7 5   G R A M S', Math.PI / 2, rad * 0.072, -1);

        // Centre mark: a chevron trio, the sort of thing that gets stamped.
        c.save();
        c.translate(cx, cy);
        c.strokeStyle = fg;
        c.lineCap = 'round';
        for (let i = 0; i < 3; i++) {
          const r = rad * (0.16 + i * 0.085);
          c.lineWidth = rad * 0.030;
          c.beginPath();
          c.arc(0, 0, r, Math.PI * 0.82, Math.PI * 1.55);
          c.stroke();
          c.beginPath();
          c.arc(0, 0, r, Math.PI * -0.18, Math.PI * 0.55);
          c.stroke();
        }
        c.restore();
      } else {
        // Underside: mould gate pip, a legal-text ring, and the rim shadow.
        c.fillStyle = 'rgba(0,0,0,0.16)';
        c.beginPath(); c.arc(cx, cy, rad * 0.905, 0, Math.PI * 2);
        c.arc(cx, cy, rad * 0.86, 0, Math.PI * 2, true); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.42)';
        c.beginPath(); c.arc(cx + rad * 0.30, cy - rad * 0.12, rad * 0.030, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(60,66,72,0.55)';
        arcText(c, cx, cy, rad * 0.70, 'PROFESSIONAL  ·  FLYING  DISC  ·  175 g', -Math.PI / 2, rad * 0.062, 1);
      }

      // Sparse manufacturing speckle so nothing is a flat fill.
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rad;
        const d = (rnd() - 0.5) * 0.14;
        c.fillStyle = d > 0 ? `rgba(255,255,255,${d})` : `rgba(0,0,0,${-d})`;
        c.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1 + rnd() * 2, 1 + rnd() * 2);
      }
      c.restore();
    };

    face(S * 0.25, true);
    face(S * 0.75, false);
  }, { colorSpace: THREE.SRGBColorSpace, wrap: THREE.ClampToEdgeWrapping, name: 'disc-albedo' });
}

/** Draw text around an arc. `dir` +1 reads clockwise, -1 counter-clockwise. */
function arcText(
  c: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  text: string, startAngle: number, size: number, dir: 1 | -1,
): void {
  c.save();
  c.font = `700 ${size.toFixed(1)}px ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  let total = 0;
  const widths: number[] = [];
  for (const ch of text) { const w = c.measureText(ch).width; widths.push(w); total += w; }
  let a = startAngle - dir * (total / r) * 0.5;
  for (let i = 0; i < text.length; i++) {
    const step = widths[i] / r;
    a += dir * step * 0.5;
    c.save();
    c.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    c.rotate(a + (dir > 0 ? Math.PI / 2 : -Math.PI / 2));
    c.fillText(text[i], 0, 0);
    c.restore();
    a += dir * step * 0.5;
  }
  c.restore();
}

/** Height field for the mould relief, then a tangent-space normal map. */
function bakeNormal(seed: number): THREE.Texture {
  const S = 512;
  const h = heightField(S, (u, v) => {
    const p = uvPolar(u, v);
    if (p.rr > 1.02) return 0;
    let y = 0;
    // Concentric injection rings. These have to stay WHISPER faint: fifteen
    // ripples across the radius at any real amplitude tilt every normal on the
    // flight plate radially, and a plate of radially-tilted normals two metres
    // above a pitch mirrors the grass — the disc renders green.
    y += 0.0045 * Math.sin(p.rr * 96) * smoothstep(1.0, 0.55, p.rr);
    // Radial flow lines from the gate.
    y += 0.004 * Math.sin(p.ang * 22 + p.rr * 5) * smoothstep(0.15, 0.6, p.rr);
    // The shoulder step and the rim edge.
    y -= 0.14 * smoothstep(0.845, 0.885, p.rr) * (1 - smoothstep(0.95, 1.0, p.rr));
    y += 0.09 * smoothstep(0.955, 0.995, p.rr);
    // The foil stamp stands very slightly proud on the plate.
    if (p.top) {
      y += 0.030 * (smoothstep(FOIL_IN - 0.012, FOIL_IN + 0.008, p.rr)
        - smoothstep(FOIL_OUT - 0.008, FOIL_OUT + 0.012, p.rr));
    }
    // Fine plastic grain.
    y += 0.007 * (fbm2(u * 260, v * 260, { octaves: 3, seed }) - 0.5);
    return y;
  });
  return heightToNormal(h, S, S, 3.4, { wrap: THREE.ClampToEdgeWrapping, name: 'disc-normal' });
}

/** G = roughness, B = metalness. The foil ring is the only metal on the disc. */
function bakeOrm(seed: number): THREE.Texture {
  const S = 512;
  return bake((_x, _y, u, v, out, i) => {
    const p = uvPolar(u, v);
    const foil = p.top
      ? smoothstep(FOIL_IN - 0.010, FOIL_IN + 0.006, p.rr) - smoothstep(FOIL_OUT - 0.006, FOIL_OUT + 0.010, p.rr)
      : 0;
    // Moulded plastic: satin on the plate, glossier where the rim was polished
    // by the tool, matte again on the underside cavity.
    let rough = 0.40 - 0.10 * smoothstep(0.86, 1.0, p.rr) + (p.top ? 0 : 0.10);
    rough += 0.055 * (valueNoise2(u * 140, v * 140, seed) - 0.5);
    // Hot-stamped foil is metal LEAF pressed into plastic, not chrome. Left at
    // a mirror roughness it becomes a perfect reflector of whatever is below —
    // which, on a pitch, means the gold ring renders green.
    rough = clamp(rough * (1 - 0.55 * foil) + 0.23 * foil, 0.05, 0.95);
    out[i] = 255;
    out[i + 1] = rough * 255;
    // Mostly-diffuse gold with a metallic sheen on top. The leaf is thin and
    // sits in a plastic well, so most of the colour arrives as diffuse — and a
    // fully metallic ring is a mirror, which over a pitch is green no matter
    // what colour you painted it.
    out[i + 2] = foil * 0.30 * 255;
    out[i + 3] = 255;
  }, { size: S, colorSpace: THREE.NoColorSpace, wrap: THREE.ClampToEdgeWrapping, name: 'disc-orm' });
}

/**
 * Radial falloff for the contact shadow, carried in ALPHA. (Multiply blending
 * is the obvious choice here and is wrong: `opacity` does not enter the
 * multiply equation, so the blob could not fade as the disc climbed.)
 */
function bakeContact(): THREE.Texture {
  const S = 128;
  return bake((_x, _y, u, v, out, i) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const k = Math.pow(clamp(1 - d, 0, 1), 1.55);
    out[i] = 0; out[i + 1] = 0; out[i + 2] = 0;
    out[i + 3] = k * 255;
  }, { size: S, colorSpace: THREE.NoColorSpace, wrap: THREE.ClampToEdgeWrapping, mips: true, name: 'disc-contact' });
}

/** Small deterministic PRNG for the canvas pass (never Math.random). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ================================================================= runtime */

export type DiscMode = 'held' | 'flight' | 'ground';

export interface TrailSample { x: number; y: number; z: number; t: number; speed: number }

export interface ThrowRequest {
  type: ThrowType;
  from: THREE.Vector3;
  /** Aim direction (only the horizontal part sets the heading). */
  aim: THREE.Vector3;
  power: number;
  angle: number;
  spin: number;
  hand?: 'R' | 'L';
  bank?: number;
  nose?: number;
}

const _wind0 = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * The headless disc. Owns the physics state and everything derived from it that
 * is not a mesh. Safe to construct in Node.
 */
export class DiscRuntime {
  readonly state: DiscState = createDiscState();
  mode: DiscMode = 'ground';
  /** Player id holding it, or -1. */
  holderId = -1;
  /** Team of the last thrower — used for trail tint and for the game system. */
  lastThrowTeam: 0 | 1 = 0;
  /** Seconds since release; blocks self-catches for a few frames. */
  sinceRelease = 1e3;
  /** 0..1 cumulative match wear. Drives the scuff map's overall strength. */
  wear = 0;

  /** Sampled flight path, newest last. */
  readonly trail: TrailSample[] = [];
  trailCapacity = 72;
  /** Seconds of path kept. Long enough to show a huck's curve, short enough
   *  that the tail is never a bar across the lens. */
  trailSeconds = 0.80;

  /** Ground height query; bound to the field system by the game. */
  groundAt: (x: number, z: number) => number = () => 0;
  wind = new THREE.Vector3();

  /** Set by the game whenever the disc lands; the visual layer consumes it. */
  pendingScuff: { rr: number; ang: number; top: boolean; strength: number } | null = null;

  private clock = 0;
  private probe = createDiscState();

  /* --------------------------------------------------------------- driving */

  /** Advance the flight by one fixed step. No-op when held or at rest. */
  step(dt: number): void {
    this.clock += dt;
    this.sinceRelease += dt;
    if (this.mode !== 'flight') { this.decayTrail(); return; }

    this.state.groundY = this.groundAt(this.state.pos.x, this.state.pos.z);
    simulate(this.state, dt, this.wind);
    if (!isFiniteState(this.state)) {
      // A non-finite state can only come from a pathological release; park it
      // rather than poisoning every consumer downstream.
      this.state.vel.set(0, 0, 0);
      this.state.omega.set(0, 0, 0);
      this.state.pos.set(0, this.state.groundY + H, 0);
      this.state.atRest = true;
      this.state.touchedGround = true;
    }
    this.pushTrail();
  }

  /** Launch. Returns the release velocity so callers can log or emit it. */
  release(req: ThrowRequest): THREE.Vector3 {
    const opts: ThrowOptions = {
      hand: req.hand ?? 'R',
      bank: req.bank,
      nose: req.nose,
      groundY: this.groundAt(req.from.x, req.from.z),
      out: this.state,
    };
    throwDisc(req.type, req.from, req.aim, req.power, req.angle, req.spin, opts);
    this.mode = 'flight';
    this.holderId = -1;
    this.sinceRelease = 0;
    this.trail.length = 0;
    this.pushTrail();
    return _v.copy(this.state.vel);
  }

  /** Pin the disc into a hand. `normal` is the disc's face direction. */
  hold(playerId: number, pos: THREE.Vector3, normal: THREE.Vector3, spinPhase = 0): void {
    this.mode = 'held';
    this.holderId = playerId;
    this.state.pos.copy(pos);
    this.state.vel.set(0, 0, 0);
    this.state.omega.set(0, 0, 0);
    this.state.atRest = false;
    this.state.touchedGround = false;
    this.state.spin = 0;
    this.state.groundY = this.groundAt(pos.x, pos.z);
    orientToNormal(this.state, normal, spinPhase);
    this.trail.length = 0;
  }

  /** Park the disc on the grass at `pos`. */
  settle(pos: THREE.Vector3): void {
    this.mode = 'ground';
    this.holderId = -1;
    this.state.pos.set(pos.x, this.groundAt(pos.x, pos.z) + H, pos.z);
    this.state.vel.set(0, 0, 0);
    this.state.omega.set(0, 0, 0);
    this.state.spin = 0;
    this.state.atRest = true;
    this.state.touchedGround = true;
    orientToNormal(this.state, UP, 0);
  }

  /** Record a ground strike so the visual layer can stamp the scuff map. */
  markScuff(strength: number): void {
    const n = discNormalWorld(this.state, _v);
    const top = n.y >= 0;
    // Which part of the disc met the grass: the low edge in world space.
    const q = this.state.orient;
    const inv = _q1.copy(q).conjugate();
    const down = _v2.set(0, -1, 0).applyQuaternion(inv);
    const rr = clamp(Math.hypot(down.x, down.y) * 1.05, 0, 1);
    const ang = Math.atan2(down.y, down.x);
    this.pendingScuff = { rr, ang, top: !top, strength };
    this.wear = clamp(this.wear + strength * 0.055, 0, 1);
  }

  /** Age of the newest trail sample, seconds. */
  get trailAge(): number {
    const s = this.trail[this.trail.length - 1];
    return s ? this.clock - s.t : 1e3;
  }

  /* ------------------------------------------------------------ prediction */

  /**
   * `ctx.sys.disc.predictPath` — the shape AI.ts probes for. It hands us its own
   * (position/velocity only) disc record; we integrate the real state when it is
   * ours and in the air, and a matching state otherwise.
   */
  predictPath(
    stateLike: { pos?: { x: number; y: number; z: number }; vel?: { x: number; y: number; z: number } },
    horizon = 6, step = 1 / 30,
  ): { t: number; x: number; y: number; z: number }[] {
    const p = this.probe;
    const live = this.mode === 'flight';
    p.pos.copy(this.state.pos);
    p.vel.copy(this.state.vel);
    p.orient.copy(this.state.orient);
    p.omega.copy(this.state.omega);
    p.groundY = this.state.groundY;
    p.touchedGround = false;
    p.atRest = false;
    p.t = 0;
    if (!live && stateLike?.pos && stateLike?.vel) {
      p.pos.set(stateLike.pos.x, stateLike.pos.y, stateLike.pos.z);
      p.vel.set(stateLike.vel.x, stateLike.vel.y, stateLike.vel.z);
    }

    const out: { t: number; x: number; y: number; z: number }[] = [];
    out.push({ t: 0, x: p.pos.x, y: p.pos.y, z: p.pos.z });
    const dt = Math.max(FIXED_DT, Math.min(1 / 20, step));
    const n = Math.max(2, Math.min(240, Math.round(Math.max(0.1, horizon) / dt)));
    for (let i = 1; i <= n; i++) {
      p.groundY = this.groundAt(p.pos.x, p.pos.z);
      simulate(p, dt, this.wind);
      out.push({ t: i * dt, x: p.pos.x, y: p.pos.y, z: p.pos.z });
      if (p.touchedGround) break;
    }
    if (out.length < 2) out.push({ ...out[0], t: dt });
    return out;
  }

  /**
   * Where a released disc first descends through `catchY`, and how far that is
   * from the release point. Used by the throw solver in Game.ts.
   */
  probeThrow(req: ThrowRequest, catchY: number, maxT = 6): { dist: number; lat: number; t: number; x: number; z: number } {
    const opts: ThrowOptions = {
      hand: req.hand ?? 'R', bank: req.bank, nose: req.nose,
      groundY: this.groundAt(req.from.x, req.from.z), out: this.probe,
    };
    const p = throwDisc(req.type, req.from, req.aim, req.power, req.angle, req.spin, opts);
    const hx = req.aim.x, hz = req.aim.z;
    const hl = Math.hypot(hx, hz) || 1;
    const ux = hx / hl, uz = hz / hl;
    let prevY = p.pos.y;
    const steps = Math.round(maxT / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      p.groundY = this.groundAt(p.pos.x, p.pos.z);
      simulate(p, FIXED_DT, this.wind);
      const dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z;
      if ((p.pos.y <= catchY && prevY > catchY) || p.touchedGround) {
        return {
          dist: dx * ux + dz * uz,
          lat: -dx * uz + dz * ux,
          t: p.t, x: p.pos.x, z: p.pos.z,
        };
      }
      prevY = p.pos.y;
    }
    const dx = p.pos.x - req.from.x, dz = p.pos.z - req.from.z;
    return { dist: dx * ux + dz * uz, lat: -dx * uz + dz * ux, t: p.t, x: p.pos.x, z: p.pos.z };
  }

  /* -------------------------------------------------------------- internal */

  private pushTrail(): void {
    const s = this.state;
    const speed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    this.trail.push({ x: s.pos.x, y: s.pos.y, z: s.pos.z, t: this.clock, speed });
    this.decayTrail();
  }

  private decayTrail(): void {
    const cut = this.clock - this.trailSeconds;
    let drop = 0;
    while (drop < this.trail.length && this.trail[drop].t < cut) drop++;
    if (drop) this.trail.splice(0, drop);
    while (this.trail.length > this.trailCapacity) this.trail.shift();
  }

  /** Seed the trail directly — used when a tableau stages a mid-flight disc. */
  setTrail(samples: readonly TrailSample[]): void {
    this.trail.length = 0;
    for (const s of samples) this.trail.push({ ...s, t: this.clock - (samples[samples.length - 1].t - s.t) });
  }

  get now(): number { return this.clock; }
}

const UP = new THREE.Vector3(0, 1, 0);
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function discNormalWorld(s: DiscState, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(s.orient);
}

/** Point the disc's body +Z at `normal`, with `phase` radians of spin about it. */
function orientToNormal(s: DiscState, normal: THREE.Vector3, phase: number): void {
  _v3.copy(normal).normalize();
  if (_v3.lengthSq() < 1e-6) _v3.set(0, 1, 0);
  _q1.setFromUnitVectors(_v2.set(0, 0, 1), _v3);
  _q2.setFromAxisAngle(_v2.set(0, 0, 1), phase);
  s.orient.copy(_q1).multiply(_q2).normalize();
}

/* ================================================================== system */

const MAX_TRAIL_VERTS = 96;
/** Fraction of a displayed frame the notional shutter is open. */
const SHUTTER = 0.40;
/** Longest ribbon the trail is ever allowed to draw, metres. */
const TRAIL_METRES = 6.5;

export class DiscSystem implements System {
  readonly name = 'disc';
  readonly order = 7;

  /** The runtime this system draws. Adopted from the game when one exists. */
  rt = new DiscRuntime();
  /** True when a peer (the game system) is stepping the runtime for us. */
  private driven = false;

  private group = new THREE.Group();
  private mesh!: THREE.Mesh;
  private mat!: THREE.MeshPhysicalMaterial;
  private trail!: THREE.Mesh;
  private trailPos!: THREE.BufferAttribute;
  private trailCol!: THREE.BufferAttribute;
  private contact!: THREE.Mesh;
  private contactMat!: THREE.MeshBasicMaterial;

  private wearTex!: THREE.DataTexture;
  private wearData!: Uint8Array;
  private wearSize = 256;

  private uSpinBlur = { value: 0 };
  private uWear = { value: null as unknown as THREE.Texture };
  private uWearAmt = { value: 0 };
  /**
   * Forward-scatter tint and gain. Warm, because what comes through 1.2 mm of
   * white polyethylene at golden hour is the key, not the sky — and strong
   * enough that a backlit disc is the brightest object on the pitch, which is
   * what `docs/art-direction.md` requires of it in every daylight frame.
   */
  private uScatter = { value: new THREE.Color(1.62, 1.52, 1.34) };

  init(ctx: Ctx): void {
    const game = ctx.sys['game'] as unknown as { discRuntime?: DiscRuntime } | undefined;
    if (game?.discRuntime) { this.rt = game.discRuntime; this.driven = true; }

    const tier = ctx.quality.tier;
    const seed = (ctx.rand.fork(0x0d15c).next() * 0xffffff) | 0;

    const geo = buildDiscGeometry(segmentsFor(tier));

    const albedo = bakeAlbedo(seed);
    // A CanvasTexture uploads flipped by default and a DataTexture does not, so
    // the canvas albedo and the baked normal/ORM/wear maps would disagree about
    // which half of the image is the top face — putting the mould gate on the
    // flight plate and the hot stamp underneath, where nothing ever sees it.
    albedo.flipY = false;
    albedo.needsUpdate = true;
    albedo.anisotropy = ctx.quality.anisotropy;
    const normal = bakeNormal(seed ^ 0x51ab);
    normal.anisotropy = ctx.quality.anisotropy;
    const orm = bakeOrm(seed ^ 0x2c9d);
    orm.anisotropy = ctx.quality.anisotropy;

    this.buildWearTexture(ctx);

    this.mat = new THREE.MeshPhysicalMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.40, 0.40),
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 1,
      metalness: 1,
      // Injection-moulded polyethylene has a real polish on it.
      clearcoat: 0.34,
      clearcoatRoughness: 0.26,
      envMapIntensity: 1.0,
      side: THREE.DoubleSide,
      name: 'disc',
    });
    this.installShader(tapsFor(tier));

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);

    /* ---- trail ---- */
    const tg = new THREE.BufferGeometry();
    const tp = new Float32Array(MAX_TRAIL_VERTS * 2 * 3);
    const tc = new Float32Array(MAX_TRAIL_VERTS * 2 * 4);
    this.trailPos = new THREE.BufferAttribute(tp, 3).setUsage(THREE.DynamicDrawUsage);
    this.trailCol = new THREE.BufferAttribute(tc, 4).setUsage(THREE.DynamicDrawUsage);
    tg.setAttribute('position', this.trailPos);
    tg.setAttribute('color', this.trailCol);
    const ti: number[] = [];
    for (let i = 0; i + 1 < MAX_TRAIL_VERTS; i++) {
      const a = i * 2;
      ti.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    tg.setIndex(ti);
    tg.setDrawRange(0, 0);
    tg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);
    this.trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, name: 'disc-trail',
    }));
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 3;
    this.trail.visible = false;
    ctx.scene.add(this.trail);

    /* ---- contact shadow ---- */
    this.contactMat = new THREE.MeshBasicMaterial({
      map: bakeContact(), transparent: true, depthWrite: false,
      color: 0x000000, toneMapped: false, name: 'disc-contact',
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.contactMat);
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.renderOrder = 1;
    this.contact.frustumCulled = false;
    ctx.scene.add(this.contact);

    ctx.scene.add(this.group);

    // Ground truth from the field system when it exists.
    const field = ctx.sys['field'] as unknown as { heightAt?(x: number, z: number): number } | undefined;
    if (!this.driven && typeof field?.heightAt === 'function') {
      this.rt.groundAt = (x, z) => field.heightAt!(x, z);
    }
    if (!this.driven) {
      // Standalone: sit the disc on the brick mark so the module is never a
      // floating cylinder in an otherwise finished frame.
      this.rt.settle(new THREE.Vector3(0, 0, -14));
    }
  }

  /** The game system calls this so we stop double-stepping the physics. */
  attachRuntime(rt: DiscRuntime): void { this.rt = rt; this.driven = true; }

  update(dt: number, _ctx: Ctx): void {
    if (!this.driven) this.rt.step(dt);
  }

  lateUpdate(dt: number, ctx: Ctx): void {
    const rt = this.rt;
    const s = rt.state;

    this.consumeScuff();

    /* ---- body ---- */
    this.group.position.copy(s.pos);
    renderQuaternion(s, this.group.quaternion);
    this.group.visible = true;

    // Rotational blur: how far the disc turns while the shutter is open. A disc
    // at 55 rad/s sweeps a full radian per 60 Hz frame, and smearing over all of
    // it turns the hot stamp into flat grey — so the arc is scaled by a
    // broadcast-like shutter fraction and clamped. What survives is a smeared
    // gold ring that reads as "spinning" while the stamp is still legible.
    const frame = Math.max(1 / 240, Math.min(dt, 1 / 24));
    const swept = Math.abs(s.spin) * frame * SHUTTER;
    this.uSpinBlur.value = Math.min(0.70, swept);
    this.uWearAmt.value = 0.35 + 0.65 * rt.wear;

    /* ---- contact shadow ---- */
    const gy = rt.groundAt(s.pos.x, s.pos.z);
    const h = Math.max(0, s.pos.y - gy);
    const near = 1 - Math.min(1, h / 5.5);
    const scale = DISC.diameter * (1.02 + 3.1 * (1 - near) * (1 - near));
    this.contact.position.set(s.pos.x, gy + 0.012, s.pos.z);
    this.contact.scale.set(scale, scale, 1);
    const dens = 0.16 + 0.72 * near * near;
    this.contactMat.opacity = rt.mode === 'held' ? dens * 0.55 : dens;
    this.contact.visible = h < 7.5;

    /* ---- trail ---- */
    this.updateTrail(ctx);
  }

  /* ---------------------------------------------------------------- shader */

  private installShader(taps: number): void {
    const uSpinBlur = this.uSpinBlur;
    const uWear = this.uWear;
    const uWearAmt = this.uWearAmt;
    const uScatter = this.uScatter;
    const N = Math.max(1, taps);

    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSpinBlur = uSpinBlur;
      shader.uniforms.uWear = uWear;
      shader.uniforms.uWearAmt = uWearAmt;
      shader.uniforms.uScatter = uScatter;

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uSpinBlur;
          uniform float uWearAmt;
          uniform sampler2D uWear;
          uniform vec3 uScatter;
          float gScuff = 0.0;
          float gStain = 0.0;
          float gThin = 0.0;
          float gScatter = 0.0;
          vec2 rotAbout(vec2 uv, vec2 c, float a) {
            float s = sin(a), k = cos(a);
            vec2 d = uv - c;
            return c + vec2(d.x * k - d.y * s, d.x * s + d.y * k);
          }
        `)
        .replace('#include <map_fragment>', /* glsl */`
          #ifdef USE_MAP
            vec2 dCentre = vec2(0.5, vMapUv.y < 0.5 ? 0.25 : 0.75);
            vec4 acc = vec4(0.0);
            vec2 wearAcc = vec2(0.0);
            for (int i = 0; i < ${N}; i++) {
              float f = ${N === 1 ? '0.0' : `(float(i) * ${(1 / (N - 1)).toFixed(6)} - 0.5) * uSpinBlur`};
              vec2 uvR = rotAbout(vMapUv, dCentre, f);
              acc += texture2D(map, uvR);
              wearAcc += texture2D(uWear, uvR).rg;
            }
            vec4 sampledDiffuseColor = acc * ${(1 / N).toFixed(6)};
            wearAcc *= ${(1 / N).toFixed(6)};
            gScuff = clamp(wearAcc.x * uWearAmt, 0.0, 1.0);
            gStain = clamp(wearAcc.y * uWearAmt, 0.0, 1.0);
            // Scuffed plastic goes pale and chalky; turf stain goes olive.
            sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb,
              sampledDiffuseColor.rgb * 0.86 + vec3(0.10, 0.10, 0.095), gScuff);
            sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb,
              sampledDiffuseColor.rgb * vec3(0.62, 0.72, 0.42), gStain * 0.60);
            diffuseColor *= sampledDiffuseColor;
            float rUv = length(vMapUv - dCentre) / ${UVR.toFixed(4)};
            /**
             * WHICH PART OF A DISC IS THIN.
             *
             * This had it inverted: the term fired at rUv > 0.86, i.e. on the
             * RIM. The rim is the thick part — that is where the 175 g lives, a
             * solid bead of polyethylene 6-7 mm through. The FLIGHT PLATE is the
             * membrane: about 1.2 mm across its whole span, which is why holding
             * a white disc up against the sky lights the middle and leaves the
             * rim a dark ring. Backlighting the plate is the entire reason a
             * disc reads as white at golden hour, and the huck framing at
             * 18.2 h is lit from directly behind the subject.
             */
            gThin = 0.30 + 0.70 * smoothstep(0.80, 0.42, rUv);
          #endif
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */`
          #include <roughnessmap_fragment>
          roughnessFactor = clamp(mix(roughnessFactor, 0.80, gScuff * 0.85) + gStain * 0.10, 0.04, 1.0);
        `)
        .replace('#include <metalnessmap_fragment>', /* glsl */`
          #include <metalnessmap_fragment>
          metalnessFactor *= (1.0 - 0.75 * gScuff);
        `)
        .replace('#include <emissivemap_fragment>', /* glsl */`
          #include <emissivemap_fragment>
          {
            // Thin-section forward scatter. Polyethylene is translucent where
            // the wall is a millimetre thick — the rim edge and the inner bead —
            // and opaque across the plate.
            vec3 Vd = normalize(vViewPosition);
            float fres = pow(1.0 - abs(dot(normalize(normal), Vd)), 2.2);
            // Across the plate the scatter is broad and view-independent (light
            // coming through a membrane); at the rim it is a grazing-angle
            // effect only. Hence the fixed floor plus the fresnel lobe.
            gScatter = gThin * (0.52 + 0.48 * fres) * (1.0 - 0.5 * gStain);
          }
        `)
        .replace('#include <lights_fragment_end>', /* glsl */`
          #include <lights_fragment_end>
          // Scaled by the light actually landing on the disc rather than added
          // as emissive, so the rim stops glowing the moment it is in shadow.
          reflectedLight.indirectDiffuse +=
            (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) * uScatter * gScatter;
        `);
    };
    this.mat.customProgramCacheKey = () => `ultimate-disc-${N}`;
  }

  /* ------------------------------------------------------------------ wear */

  private buildWearTexture(ctx: Ctx): void {
    const S = this.wearSize;
    const data = new Uint8Array(S * S * 4);
    const salt = ctx.rand.fork(0x5c0ff).int(0, 4095);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, v = (y + 0.5) / S;
        const p = uvPolar(u, v);
        const i = (y * S + x) * 4;
        // A match-worn disc starts with a little life on it already.
        let scuff = 0;
        if (p.rr <= 1.02) {
          scuff = 0.16 * fbm2(u * 22, v * 22, { octaves: 3, seed: salt })
            + 0.34 * smoothstep(0.90, 1.02, p.rr);
        }
        data[i] = clamp(scuff, 0, 1) * 255;
        data[i + 1] = p.top ? 0 : clamp(0.10 * fbm2(u * 31 + 4, v * 31, { octaves: 2, seed: salt + 3 }), 0, 1) * 255;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
    this.wearData = data;
    this.wearTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    this.wearTex.wrapS = this.wearTex.wrapT = THREE.ClampToEdgeWrapping;
    this.wearTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.wearTex.magFilter = THREE.LinearFilter;
    this.wearTex.generateMipmaps = true;
    this.wearTex.needsUpdate = true;
    this.wearTex.name = 'disc-wear';
    this.uWear.value = this.wearTex;
  }

  /** Stamp a ground strike into the wear map at the point that hit. */
  private consumeScuff(): void {
    const s = this.rt.pendingScuff;
    if (!s) return;
    this.rt.pendingScuff = null;
    const S = this.wearSize;
    const cv = s.top ? 0.25 : 0.75;
    const vs = s.top ? 1 : -1;
    const cu = 0.5 + UVR * s.rr * Math.cos(s.ang);
    const cvv = cv + UVR * s.rr * Math.sin(s.ang) * vs;
    const px = cu * S, py = cvv * S;
    const rad = S * 0.055 * (0.7 + 0.6 * s.strength);
    const x0 = Math.max(0, Math.floor(px - rad)), x1 = Math.min(S - 1, Math.ceil(px + rad));
    const y0 = Math.max(0, Math.floor(py - rad)), y1 = Math.min(S - 1, Math.ceil(py + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - px, y - py) / rad;
        if (d > 1) continue;
        const k = (1 - d * d) * (0.55 + 0.45 * hash2(x, y, 91));
        const i = (y * S + x) * 4;
        this.wearData[i] = Math.min(255, this.wearData[i] + k * 150 * s.strength);
        this.wearData[i + 1] = Math.min(255, this.wearData[i + 1] + k * 110 * s.strength);
      }
    }
    this.wearTex.needsUpdate = true;
  }

  /* ----------------------------------------------------------------- trail */

  private updateTrail(ctx: Ctx): void {
    const rt = this.rt;
    const src = rt.trail;
    const geo = this.trail.geometry;
    if (rt.mode === 'ground' && rt.trailAge > 0.45) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }
    const n = Math.min(src.length, MAX_TRAIL_VERTS);
    if (n < 3) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }

    const cam = ctx.camera.position;
    const pos = this.trailPos.array as Float32Array;
    const col = this.trailCol.array as Float32Array;
    let start = src.length - n;
    const newest = src[src.length - 1];

    // Cap the ribbon by ARC LENGTH, not time. A 24 m/s huck covers 19 m in the
    // trail window; drawn from four metres away that is a bar across the lens,
    // not a broadcast trail. Metres are what the eye reads, so metres are what
    // we budget.
    {
      let run = 0;
      let i = src.length - 1;
      for (; i > start; i--) {
        const a = src[i], b = src[i - 1];
        run += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (run > TRAIL_METRES) break;
      }
      start = Math.max(start, i);
    }
    const count = src.length - start;
    if (count < 3) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }

    // A broadcast trail is a speed cue, not a decoration: a dump barely marks
    // the air, a huck leaves a full ribbon.
    const zip = Math.min(1, Math.max(0, (newest.speed - 8) / 16));
    const gain = zip * zip;
    if (gain < 0.02) { this.trail.visible = false; geo.setDrawRange(0, 0); return; }

    for (let i = 0; i < count; i++) {
      const s = src[start + i];
      const prev = src[Math.max(start, start + i - 1)];
      const next = src[Math.min(src.length - 1, start + i + 1)];
      _v.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
      if (_v.lengthSq() < 1e-10) _v.set(0, 0, 1);
      _v.normalize();
      _v2.set(s.x - cam.x, s.y - cam.y, s.z - cam.z).normalize();
      _v3.crossVectors(_v, _v2);
      if (_v3.lengthSq() < 1e-10) _v3.set(1, 0, 0); else _v3.normalize();

      const age = (i + 1) / count;                   // 0 oldest .. 1 newest
      const taper = age * age;
      const w = DISC.diameter * (0.02 + 0.38 * taper) * (0.45 + 0.55 * gain);
      const a = taper * age * 0.52 * gain;

      const k = i * 6, kc = i * 8;
      pos[k] = s.x - _v3.x * w; pos[k + 1] = s.y - _v3.y * w; pos[k + 2] = s.z - _v3.z * w;
      pos[k + 3] = s.x + _v3.x * w; pos[k + 4] = s.y + _v3.y * w; pos[k + 5] = s.z + _v3.z * w;
      for (let e = 0; e < 2; e++) {
        col[kc + e * 4] = 0.78; col[kc + e * 4 + 1] = 0.84; col[kc + e * 4 + 2] = 0.95;
        col[kc + e * 4 + 3] = a;
      }
    }
    this.trailPos.needsUpdate = true;
    this.trailCol.needsUpdate = true;
    geo.setDrawRange(0, (count - 1) * 6);
    this.trail.visible = true;
  }

  /* --------------------------------------------------------------- queries */

  /** `ctx.sys.disc.predictPath` — the AI peer contract. */
  predictPath(state: any, horizon = 6, step = 1 / 30): { t: number; x: number; y: number; z: number }[] {
    return this.rt.predictPath(state, horizon, step);
  }

  /** World position of the disc right now. */
  position(out = new THREE.Vector3()): THREE.Vector3 { return out.copy(this.rt.state.pos); }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.mat?.dispose();
    this.trail?.geometry.dispose();
    (this.trail?.material as THREE.Material)?.dispose();
    this.contact?.geometry.dispose();
    this.contactMat?.dispose();
    this.wearTex?.dispose();
  }
}
