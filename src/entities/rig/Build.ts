import * as THREE from 'three';

/**
 * Low-level geometry plumbing for the procedural athlete.
 *
 * Everything in the body is a *loft*: an ordered stack of cross-section rings,
 * each with its own centre, local frame, radial profile and skin binding,
 * stitched into a quad grid. That single primitive is what buys loop topology —
 * a joint is simply "put three rings close together and bias their weights",
 * which is exactly what a character artist does by hand and exactly what keeps
 * an elbow from collapsing at 130 degrees.
 *
 * Vertices land in one shared buffer; triangles are bucketed per material index
 * so the finished geometry carries contiguous `addGroup` ranges (skin, jersey,
 * shorts, socks, shoes, hair, eyes) over a single vertex array.
 *
 * Attribute set written here — the material author's contract:
 *   position, normal, uv          standard
 *   skinIndex, skinWeight         4 influences, normalised
 *   aPart   float   part id, see PART in Types.ts (head, torso, upperArm, ...)
 *   aSide   float   -1 right limb, 0 centre, +1 left limb
 *   aCrease float   0..1 baked cavity term — armpit, groin, neck root, elbow
 *                   pit, under-pec, eye socket. Multiply into AO / darken
 *                   albedo; it is the cheap substitute for a baked AO map.
 *   aLen    float   0..1 along-part parameter (0 at the proximal ring), so a
 *                   shader can taper, fade or band a limb without knowing its
 *                   world extent.
 */

export type Vec3 = THREE.Vector3;
export const V = (x = 0, y = 0, z = 0): Vec3 => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------------- skin */

/** Up to four bone influences. Indices are into `Skeleton.bones`. */
export interface Skin {
  readonly i: readonly [number, number, number, number];
  readonly w: readonly [number, number, number, number];
}

/** Single-bone binding. */
export function sk1(i: number): Skin {
  return { i: [i, 0, 0, 0], w: [1, 0, 0, 0] };
}

/** Two-bone binding, weights normalised. */
export function sk2(a: number, wa: number, b: number, wb: number): Skin {
  const s = wa + wb;
  if (s <= 1e-6) return sk1(a);
  return { i: [a, b, 0, 0], w: [wa / s, wb / s, 0, 0] };
}

/** Arbitrary binding from (bone, weight) pairs — keeps the four heaviest. */
export function skN(pairs: readonly (readonly [number, number])[]): Skin {
  const acc = new Map<number, number>();
  for (const [i, w] of pairs) {
    if (w <= 1e-5) continue;
    acc.set(i, (acc.get(i) ?? 0) + w);
  }
  const list = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
  if (!list.length) return sk1(0);
  let s = 0;
  for (const e of list) s += e[1];
  const i: [number, number, number, number] = [0, 0, 0, 0];
  const w: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < list.length; k++) { i[k] = list[k][0]; w[k] = list[k][1] / s; }
  return { i, w };
}

/** Linear blend of two bindings — the workhorse for lofting down a limb. */
export function skMix(a: Skin, b: Skin, t: number): Skin {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pairs: [number, number][] = [];
  for (let k = 0; k < 4; k++) {
    if (a.w[k] > 0) pairs.push([a.i[k], a.w[k] * (1 - t)]);
    if (b.w[k] > 0) pairs.push([b.i[k], b.w[k] * t]);
  }
  return skN(pairs);
}

/* ------------------------------------------------------------------ rings */

/** Radial profile in the ring's own 2D frame: t in [0,1) around, returns (a, b). */
export type Profile = (t: number) => readonly [number, number];

export interface Ring {
  /** Centre, bind/world space. */
  o: Vec3;
  /** Local +a axis (unit). For torso and limbs this points to the athlete's LEFT. */
  ax: Vec3;
  /** Local +b axis (unit). Points FORWARD (+Z-ish). */
  az: Vec3;
  /** Cross-section. */
  r: Profile;
  /** Binding used for the whole ring unless `skinAt` overrides. */
  skin: Skin;
  /** Per-angle binding — how a joint gets asymmetric weights (crease side snaps,
   *  outer side blends wide) without hand-painting vertices. */
  skinAt?: (t: number) => Skin;
  /**
   * Per-angle displacement along the ring's NORMAL (`ax × az` unless `ay` says
   * otherwise), i.e. the one direction a planar ring cannot reach on its own.
   *
   * This is what a scooped neckline is: the jersey's top loops have to climb the
   * trapezius out at the shoulder and drop to the jugular notch at the front, at
   * the same u. Faking it with an extra stack of rings puts a horizontal ledge
   * across the chest — which is the ledge the critic reads as a collar plate.
   */
  off?: (t: number) => number;
  /** Override for the displacement axis used by `off`. */
  ay?: Vec3;
  /** Texture v, and the value written to aLen. */
  v: number;
  /** Baked cavity term for the ring, optionally per angle. */
  crease?: number | ((t: number) => number);
}

const TAU = Math.PI * 2;

/** Shortest signed distance between two angles expressed as [0,1) fractions. */
export function dt(a: number, b: number): number {
  let d = a - b;
  d -= Math.round(d);
  return d;
}

/** Gaussian lobe centred at `c` (in t units) with half-width `w`. */
export function lobe(t: number, c: number, w: number): number {
  const d = dt(t, c) / w;
  return Math.exp(-d * d);
}

/**
 * Ellipse with additive harmonic lobes. This is how every anatomical bump in
 * the body is made: a pec is two lobes at t≈0.19/0.31, a scapula is two at
 * t≈0.66/0.84, the abdominal groove is a negative lobe at t=0.25.
 */
export interface Lobe { at: number; w: number; amp: number; }

export function ellipse(a: number, b: number, lobes?: readonly Lobe[], pow = 2): Profile {
  if (pow === 2 && !lobes) {
    return (t) => {
      const th = t * TAU;
      return [a * Math.cos(th), b * Math.sin(th)];
    };
  }
  const p = 2 / pow;
  return (t) => {
    const th = t * TAU;
    const c = Math.cos(th), s = Math.sin(th);
    // Superellipse via signed power — pow > 2 squares the section off.
    const ca = Math.sign(c) * Math.pow(Math.abs(c), p);
    const sa = Math.sign(s) * Math.pow(Math.abs(s), p);
    let k = 0;
    if (lobes) for (const L of lobes) k += L.amp * lobe(t, L.at, L.w);
    return [a * ca * (1 + k), b * sa * (1 + k)];
  };
}

/** Scale a profile uniformly (used to derive a clothing shell from a body ring). */
export function grow(p: Profile, add: number, mul = 1): Profile {
  return (t) => {
    const [a, b] = p(t);
    const len = Math.hypot(a, b) || 1e-6;
    return [(a * mul) + (a / len) * add, (b * mul) + (b / len) * add];
  };
}

/** Copy a ring, offsetting its surface outward — a clothing shell in one line. */
export function shell(r: Ring, add: number, mul = 1): Ring {
  return { ...r, r: grow(r.r, add, mul) };
}

/* --------------------------------------------------------------- builder */

export interface LoftOpts {
  part: number;
  side: number;
  /** Fan-cap the first / last ring to its centre. */
  capStart?: boolean;
  capEnd?: boolean;
  /** Flip winding (used for inside-out shells). */
  flip?: boolean;
  /** u range mapped across the ring; default 0..1. */
  u0?: number;
  u1?: number;
  /** Do not close the ring back onto itself (open shells: hair cards, lids). */
  open?: boolean;
}

const _p = new THREE.Vector3();
const _ay = new THREE.Vector3();

export class RigMesh {
  private P: number[] = [];
  private U: number[] = [];
  private SI: number[] = [];
  private SW: number[] = [];
  private PT: number[] = [];
  private SD: number[] = [];
  private CR: number[] = [];
  private LN: number[] = [];
  private idx = new Map<number, number[]>();
  private cur = 0;
  /** Seam vertex pairs whose normals must be averaged so tubes look closed. */
  private seams: number[] = [];
  vcount = 0;

  /** All subsequent triangles go into this material slot. */
  group(m: number): this { this.cur = m; return this; }

  vert(p: Vec3, u: number, v: number, s: Skin, part: number, side: number, crease: number, len: number): number {
    this.P.push(p.x, p.y, p.z);
    this.U.push(u, v);
    this.SI.push(s.i[0], s.i[1], s.i[2], s.i[3]);
    this.SW.push(s.w[0], s.w[1], s.w[2], s.w[3]);
    this.PT.push(part);
    this.SD.push(side);
    this.CR.push(crease);
    this.LN.push(len);
    return this.vcount++;
  }

  private bucket(): number[] {
    let a = this.idx.get(this.cur);
    if (!a) this.idx.set(this.cur, (a = []));
    return a;
  }

  tri(a: number, b: number, c: number): void { this.bucket().push(a, b, c); }

  quad(a: number, b: number, c: number, d: number): void {
    const k = this.bucket();
    k.push(a, b, d, b, c, d);
  }

  seam(a: number, b: number): void { this.seams.push(a, b); }

  /** Stitch a stack of rings into a tube. Returns the base vertex index. */
  loft(rings: readonly Ring[], segs: number, o: LoftOpts): number {
    const open = !!o.open;
    const cols = open ? segs + 1 : segs + 1; // duplicate seam column either way
    const base = this.vcount;
    const u0 = o.u0 ?? 0, u1 = o.u1 ?? 1;
    const span = Math.max(1e-6, rings.length - 1);

    for (let ri = 0; ri < rings.length; ri++) {
      const R = rings[ri];
      const rowBase = this.vcount;
      const crease = R.crease;
      if (R.off) {
        if (R.ay) _ay.copy(R.ay);
        else _ay.crossVectors(R.ax, R.az).normalize();
      }
      for (let j = 0; j < cols; j++) {
        const tt = j / segs;
        const t = open ? tt : (j === segs ? 0 : tt);
        const [a, b] = R.r(t);
        _p.copy(R.o).addScaledVector(R.ax, a).addScaledVector(R.az, b);
        if (R.off) _p.addScaledVector(_ay, R.off(t));
        const s = R.skinAt ? R.skinAt(t) : R.skin;
        const cr = typeof crease === 'function' ? crease(t) : (crease ?? 0);
        this.vert(_p, u0 + (u1 - u0) * tt, R.v, s, o.part, o.side, cr, ri / span);
      }
      if (!open) this.seam(rowBase, rowBase + segs);
    }

    for (let ri = 0; ri < rings.length - 1; ri++) {
      const a0 = base + ri * cols;
      const b0 = a0 + cols;
      for (let j = 0; j < segs; j++) {
        if (o.flip) this.quad(a0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
        else this.quad(a0 + j, b0 + j, b0 + j + 1, a0 + j + 1);
      }
    }

    if (o.capStart) this.cap(rings[0], base, cols, segs, o, true);
    if (o.capEnd) this.cap(rings[rings.length - 1], base + (rings.length - 1) * cols, cols, segs, o, false);
    return base;
  }

  private cap(R: Ring, row: number, _cols: number, segs: number, o: LoftOpts, start: boolean): void {
    const cr = typeof R.crease === 'function' ? R.crease(0) : (R.crease ?? 0);
    const c = this.vert(R.o, 0.5, R.v, R.skin, o.part, o.side, cr, start ? 0 : 1);
    // A start cap faces −dirStep, an end cap faces +dirStep, and `flip` inverts
    // both along with the tube itself.
    for (let j = 0; j < segs; j++) {
      const a = row + j, b = row + j + 1;
      if (start !== !!o.flip) this.tri(c, a, b);
      else this.tri(c, b, a);
    }
  }

  /**
   * Radially displaced sphere — the head, the eyeball and the hair cap all come
   * from this. `f` returns a world-space point given the unit direction and its
   * (u, v); returning the direction scaled is the identity sphere.
   */
  sphereish(
    su: number, sv: number,
    f: (dir: Vec3, u: number, v: number, out: Vec3) => void,
    bind: (p: Vec3, u: number, v: number) => Skin,
    o: LoftOpts & {
      creaseFn?: (p: Vec3, u: number, v: number) => number;
      /** Azimuth clustering toward u = 0. 0 = uniform, 0.5 halves the front step. */
      warpU?: number;
      /** Polar clustering toward the equator. */
      warpV?: number;
    },
  ): number {
    const base = this.vcount;
    const dir = new THREE.Vector3();
    const out = new THREE.Vector3();
    // A uniform lat-long grid spends most of its rows on the back of the skull
    // and cannot resolve a 26 mm palpebral aperture. Both warps are monotone and
    // fix the endpoints, so the seam and the poles are untouched.
    const wu = o.warpU ?? 0, wv = o.warpV ?? 0;
    const mapU = (t: number) => (wu ? t - (wu * Math.sin(TAU * t)) / TAU : t);
    const mapV = (t: number) => (wv ? t + (wv * Math.sin(TAU * t)) / TAU : t);
    for (let iy = 0; iy <= sv; iy++) {
      const v = mapV(iy / sv);
      const phi = v * Math.PI;
      const rowBase = this.vcount;
      for (let ix = 0; ix <= su; ix++) {
        const u = mapU(ix / su);
        const th = u * TAU;
        dir.set(Math.sin(phi) * Math.sin(th), Math.cos(phi), Math.sin(phi) * Math.cos(th));
        f(dir, u, v, out);
        const s = bind(out, u, v);
        this.vert(out, u, 1 - v, s, o.part, o.side, o.creaseFn ? o.creaseFn(out, u, v) : 0, 1 - v);
      }
      this.seam(rowBase, rowBase + su);
    }
    const cols = su + 1;
    for (let iy = 0; iy < sv; iy++) {
      for (let ix = 0; ix < su; ix++) {
        const a = base + iy * cols + ix;
        const b = a + cols;
        if (o.flip) this.quad(a, a + 1, b + 1, b);
        else this.quad(a, b, b + 1, a + 1);
      }
    }
    return base;
  }

  triangles(): number {
    let n = 0;
    for (const a of this.idx.values()) n += a.length;
    return n / 3;
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.SW, 4));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.PT, 1));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(this.SD, 1));
    g.setAttribute('aCrease', new THREE.Float32BufferAttribute(this.CR, 1));
    g.setAttribute('aLen', new THREE.Float32BufferAttribute(this.LN, 1));

    const keys = [...this.idx.keys()].sort((a, b) => a - b);
    const total = this.triangles() * 3;
    const arr = this.vcount > 65535 ? new Uint32Array(total) : new Uint16Array(total);
    let off = 0;
    for (const k of keys) {
      const src = this.idx.get(k)!;
      arr.set(src, off);
      g.addGroup(off, src.length, k);
      off += src.length;
    }
    g.setIndex(new THREE.BufferAttribute(arr, 1));
    g.computeVertexNormals();

    // Weld the duplicated seam column so a lofted tube has no visible facet
    // line running down it. Cheaper and more reliable than trying to keep the
    // seam welded through the whole build.
    const N = g.attributes.normal as THREE.BufferAttribute;
    for (let s = 0; s < this.seams.length; s += 2) {
      const a = this.seams[s], b = this.seams[s + 1];
      const nx = N.getX(a) + N.getX(b), ny = N.getY(a) + N.getY(b), nz = N.getZ(a) + N.getZ(b);
      const l = Math.hypot(nx, ny, nz) || 1;
      N.setXYZ(a, nx / l, ny / l, nz / l);
      N.setXYZ(b, nx / l, ny / l, nz / l);
    }
    N.needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ------------------------------------------------------------------ maths */

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * Bone-space frame: local +Y runs down the bone toward its child, local +Z is
 * pushed as close to `fwd` as the constraint allows. This is the Blender / glTF
 * convention and it is what makes "twist" mean `rotation.y` on every limb bone.
 */
export function frameQuat(dir: Vec3, fwd: Vec3): THREE.Quaternion {
  const y = dir.clone().normalize();
  const z = fwd.clone().addScaledVector(y, -fwd.dot(y));
  if (z.lengthSq() < 1e-9) {
    z.set(0, 0, 1).addScaledVector(y, -y.z);
    if (z.lengthSq() < 1e-9) z.set(1, 0, 0).addScaledVector(y, -y.x);
  }
  z.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(x, y, z),
  );
}
