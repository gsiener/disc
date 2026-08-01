import * as THREE from 'three';
import { PART, GROUP } from './Types.ts';
import type { BoneName } from './Types.ts';
import { SIDES, SIDE_SUFFIX, bi } from './Skeleton.ts';
import type { Anthro } from './Skeleton.ts';
import {
  RigMesh, V, ellipse, lobe, dt, sk2, skN, skMix, smooth, lerp, clamp01,
} from './Build.ts';
import type { Ring, Skin, Vec3, Profile } from './Build.ts';
import {
  torsoCentre, torsoProfile, torsoSkin, curve, armSurface, armSkin, legSkin,
  CAP_Q, TORSO_TOP_U,
} from './Body.ts';
import type { DetailSpec } from './Body.ts';

/**
 * Clothing. Every garment is a genuine shell offset from the body surface with
 * its own hem, cuff and collar folds — never a texture painted on skin. The
 * folds are three extra rings each and they are the difference between "wearing
 * a jersey" and "painted blue from the waist up": a hem you can see the
 * underside of is the cue the eye actually checks.
 *
 * Garments inherit the body's skin weights exactly, so cloth and the limb inside
 * it deform together and nothing pokes through on a layout.
 */

/**
 * Where two garment pieces overlap they MUST share a binding, not merely sit
 * near each other. The jersey body and its sleeve meet inside the deltoid; the
 * shorts yoke and its leg tube meet inside the hip. If the two sides of that
 * overlap are weighted differently, a raised arm or a lifted knee shears them
 * apart and opens a hole straight through the athlete — which is exactly what
 * the first pass did on every layout pose.
 *
 * THIS FILE NO LONGER AUTHORS ANY OF THOSE WEIGHTS. It used to keep private
 * copies — `shoulderSkin`, `hipSkin`, `waistSkin` — and every one of them had
 * drifted from the body underneath:
 *
 *   • The jersey shell took `torsoSkin(a,u,t)`, which ALREADY blends the
 *     shoulder corner onto the clavicle, and then blended a second 42/38/20
 *     mix on top of it with a different exponent (2.0 vs 1.6), a different
 *     weight (0.8 vs 0.62) and a different release (1.075→1.0 vs
 *     TORSO_TOP_U→1.005). The garment therefore carried upper-arm weight the
 *     chest under it did not have.
 *   • The sleeve ramped `smooth(0.02, 0.50, q)` while the arm inside it ramps
 *     `smooth(0.10, -0.34, q)`. At q = 0.10 the arm is 100 % humerus and the
 *     sleeve was 93 % clavicle-mix — a quarter-turn of shoulder apart.
 *   • The shorts yoke double-blended over `torsoSkin`'s own femur term, and
 *     `hipSkin` was 54 % femur against the body's `hipBind` at 32 %.
 *
 * The visible result is the one `deltoidBind` predicts: the skin does not tear
 * the cloth, it simply arrives in front of it, and the closeup renders a bare
 * deltoid and a bare upper chest sitting proud of an intact jersey.
 *
 * Every garment now binds by CALLING the body's own function for the surface it
 * covers — `torsoSkin`, `armSkin`, `legSkin` — so the two cannot disagree even
 * in principle.
 */

/**
 * Raised-cosine window over a loop, centred at `c` and exactly zero (with zero
 * slope) beyond `half`. Used wherever a garment edge has to be somewhere other
 * than the plane of its own loop — a scooped neckline, the front rise of a pair
 * of shorts. A Gaussian is the wrong tool for both: it leaks a fifth of its
 * amplitude a quarter-turn away, which drags the shoulder seam down with the
 * collar and the hip down with the crotch.
 */
function win(t: number, c: number, half: number): number {
  const dd = Math.abs(dt(t, c)) / half;
  return dd >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * dd);
}

/**
 * ============================================================================
 *  FOLD STRUCTURE
 * ============================================================================
 *
 * A jersey with a weave and a gradient on it is a balloon. What makes cloth read
 * as cloth under a hero crop is not the thread — it is that the surface has a
 * DIRECTION of failure. Cloth is inextensible along the yarn and free to buckle
 * across it, so it gathers wherever the body underneath is shorter than the
 * panel cut for it, and on a running athlete those places are never arbitrary.
 * They are the same three, every time:
 *
 *   the armpit      the sleeve drags the front panel toward the shoulder, so a
 *                   family of diagonal folds leaves each armpit and runs down
 *                   and forward across the ribs.
 *   the waist       an untucked shirt is cut straight and the body tapers under
 *                   it, so the surplus hangs in vertical flutes that deepen
 *                   toward the hem and iron out where the chest pulls taut.
 *   the small of    the lumbar hollow is the deepest concavity on the trunk and
 *   the back        cloth cannot follow it. It bridges, and the surplus gathers
 *                   into two or three near-horizontal folds above the hip.
 *
 * All three are expressed as a modulation of the garment's OWN STANDOFF, never
 * of its radius. That is the only formulation that cannot fail: a fold is cloth
 * moving toward or away from the body, so it is bounded by the standoff on one
 * side and by nothing on the other, and the shell can never be driven through
 * the athlete however the amplitudes are tuned. It also scales itself for free —
 * the hem hangs 34 mm off the body and flutes deeply, the shoulder hangs 9 mm
 * off it and barely creases, which is exactly what cloth does.
 *
 * Every family's wavelength is chosen against the LOOP COUNT, not against the
 * garment. A fold narrower than four segments is not a fold, it is aliasing with
 * a sinusoid's name, and the jersey therefore lofts at 1.75x the torso's segment
 * count (see `buildJersey`) so that a 12 cm drape fold has eight vertices across
 * it instead of three.
 */
interface Fold {
  /** Standoff multiplier offset: −1 presses the cloth flat, +1 doubles the gap. */
  rel: number;
  /** Occlusion riding in the trough, added to the ring's baked crease. */
  shade: number;
}

function jerseyFold(u: number, t: number): Fold {
  let rel = 0;
  let shade = 0;

  /* 1. ARMPIT DRAG. One family per armpit, at the same two azimuths
   *    `buildTorso` puts its armpit hollow on. The phase advances in BOTH t and
   *    u, which is what makes the folds diagonal — a fold that runs straight
   *    around the ribs is a corrugation, and it reads as one instantly. */
  const pit = smooth(0.50, 0.79, u) * smooth(1.035, 0.885, u);
  if (pit > 0.004) {
    for (let k = 0; k < 2; k++) {
      const d = dt(t, k === 0 ? 0.05 : 0.45);
      // The drag dies out a sixth of a turn from the pit: past that the panel is
      // held flat by the pectoral in front and the scapula behind.
      const reach = Math.exp(-Math.pow(d / 0.150, 2));
      const c = Math.cos(Math.PI * 2 * (d / 0.170 - (u - 0.86) / 0.34));
      rel += 0.40 * pit * reach * c;
      shade += 0.34 * pit * reach * Math.max(0, -c);
    }
  }

  /* 2. WAIST BLOUSE. Strictly NON-NEGATIVE, and that is a load-bearing choice
   *    rather than an aesthetic one: this band is the band the shorts' waistband
   *    runs up inside, and a trough here is the one way the two shells can be
   *    made to intersect. A blouse only ever moves cloth away from the body. */
  const blouse = smooth(0.46, 0.10, u);
  if (blouse > 0.004) {
    const c = 0.5 - 0.5 * Math.cos(Math.PI * 2 * (t * 6 + 0.28 + u * 0.55));
    // Suppressed across the number panel. A heat-set transfer genuinely does
    // stiffen the fabric it sits on, and it is also the one graphic the hero
    // framing exists to read.
    const clear = 1 - 0.70 * lobe(t, 0.25, 0.115);
    rel += 0.44 * blouse * clear * c;
    shade += 0.30 * blouse * clear * (1 - c);
  }

  /* 3. SMALL OF THE BACK. Near-horizontal, so this is the one family that needs
   *    loops in u rather than segments in t — see the ring list in
   *    `buildJersey`, which is twice as dense through this band as it was. */
  const lum = smooth(0.09, 0.26, u) * smooth(0.62, 0.40, u) * lobe(t, 0.75, 0.185);
  if (lum > 0.004) {
    const c = Math.cos(Math.PI * 2 * (u - 0.235) / 0.235);
    rel += 0.46 * lum * c;
    shade += 0.40 * lum * Math.max(0, -c);
  }

  return { rel, shade };
}

const _ayTmp = new THREE.Vector3();
/** World point on a ring at angle t, honouring `Ring.off`. */
function ringPoint(R: Ring, t: number): Vec3 {
  const [x, y] = R.r(t);
  const p = R.o.clone().addScaledVector(R.ax, x).addScaledVector(R.az, y);
  if (R.off) {
    const ay = R.ay ?? _ayTmp.crossVectors(R.ax, R.az).normalize();
    p.addScaledVector(ay, R.off(t));
  }
  return p;
}

/* ----------------------------------------------------------------- jersey */

/**
 * Torso-u at which the jersey stops. The SHORTS read this: everything above the
 * line is under the shirt, and is drawn in to sit inside it — see `buildShorts`.
 * Keeping the number in one place is the only reason the two garments cannot
 * drift apart, which is what they had done.
 */
const JERSEY_HEM_U = -0.045;

export function buildJersey(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  // A FOLD IS A SAMPLING PROBLEM BEFORE IT IS A MODELLING ONE. The torso's own
  // 27 segments give a 12 cm drape fold three vertices across, which reconstructs
  // as a triangular corrugation — so the jersey lofts finer than the body it
  // covers. It is the cheapest geometry in the athlete: the whole increase is
  // about 1,700 triangles on a hero-tier player.
  const seg = d.level === 0 ? Math.round(d.torsoSegs * 1.75)
    : d.level === 1 ? Math.round(d.torsoSegs * 1.35) : d.torsoSegs;
  // The hem must sit clearly OUTSIDE the shorts' waistband (0.0165) or the two
  // shells z-fight into a sawtooth right across the athlete's waist. Ultimate
  // jerseys are worn untucked, so flaring the hem is also the correct look.
  // Down at the hem the jersey has to clear the shorts' waistband AND the flare
  // the shorts now carry over the tops of the thighs, or the shorts tear through
  // the shirt in exactly the band a broadcast camera frames.
  const off = curve([
    [-0.10, 0.0360], [0.05, 0.0310], [0.30, 0.0216], [0.55, 0.0128],
    // …and a few more millimetres across the shoulder girdle than the 0.0088 it
    // used to carry. That was 8.8 mm of standoff against a skin surface that
    // carries its own normal and detail relief, on the one band of the torso
    // where the section is a cornered slab. A jersey hangs off the chest; it
    // does not shrink-wrap the clavicles.
    // Across the acromion the shell also has to LAP THE SLEEVE. The sleeve is a
    // parallel offset of the deltoid and the body is a parallel offset of the
    // shoulder girdle; where the two arrive at the same place with 13 mm each
    // they meet tangentially and leave a knife-edge V between them that is in
    // full shadow from every direction — the dark notch sitting on the point of
    // the shoulder in every closeup. Two shells that INTERSECT have no notch;
    // two that kiss always do. These millimetres buy the intersection.
    [0.76, 0.0138], [0.90, 0.0152], [1.0, 0.0146], [TORSO_TOP_U, 0.0092],
  ]);
  // The hem sits at 0.523 H — mid-hip, and clear of the shorts' front rise. At
  // 0.508 H it hung an inch above the crotch and its turned-back underside drew
  // a dark slot straight across the athlete at exactly the height the shorts
  // needed to read.
  const hemU = JERSEY_HEM_U;
  /**
   * THE NECKLINE IS A SCOOP, NOT A RING.
   *
   * The garment has to be at 0.847 H where it meets the neck at the SIDE (that
   * is where the trapezius stops) and at 0.824 H at the front (that is where a
   * crew neck sits, a centimetre above the jugular notch). Those are the same
   * loop. Building them as two loops one above the other is what put the collar
   * 3 cm too high and left 1.5 cm of visible neck on a figure that should show
   * eight — which is most of what "the neck is too short" was.
   *
   * `Ring.off` displaces along the loop's normal, so one loop does both.
   */
  // Gate the drop on the LOOP'S OWN WIDTH, never on u. A loop 20 cm across is
  // the shoulder and must not move a millimetre; a loop 6 cm across is the
  // neckline and is free to drop 4 cm. Ramping on u instead takes the whole
  // upper chest and both trapezii down with the collar and puts the athlete in
  // a boat neck with bare shoulders — which is exactly what it did.
  const latHalf = (u: number) => Math.abs(torsoProfile(a, u)(0)[0]);
  const scoop = (u: number) =>
    0.0190 * H * smooth(a.g.chestA * 1.05, a.g.neckA * 1.15, latHalf(u));
  const neckWin = (t: number) => win(t, 0.25, 0.175) + 0.40 * win(t, 0.75, 0.200);
  const scoopAt = (u: number) => {
    const s = scoop(u);
    if (s < 1e-5) return undefined;
    return (t: number) => s * neckWin(t);
  };
  // Loops through the lumbar and armpit bands are twice as dense as they were.
  // The two fold families that run round the body rather than down it are
  // resolved by these, not by `seg`, and at the old 0.10 spacing a 24 cm lumbar
  // gather had two loops in it — which is a facet, not a fold.
  const us = d.level === 0
    ? [hemU, -0.015, 0.02, 0.055, 0.09, 0.135, 0.18, 0.23, 0.28, 0.33, 0.38,
      0.435, 0.49, 0.545, 0.60, 0.65, 0.70, 0.745, 0.79, 0.825, 0.858, 0.885,
      0.912, 0.952, 0.980, 1.004, 1.016, 1.030, 1.042, TORSO_TOP_U]
    : d.level === 1
      ? [hemU, 0.02, 0.10, 0.19, 0.29, 0.40, 0.52, 0.64, 0.76, 0.86, 0.930, 0.986, 1.012, TORSO_TOP_U]
      : [hemU, 0.12, 0.42, 0.72, 0.95, TORSO_TOP_U];

  const shellRing = (u: number, extra = 0): Ring => {
    const base = torsoProfile(a, u);
    const nominal = off(u);
    // Cloth does not follow anatomy exactly — it bridges the pec valley and the
    // spinal furrow. Blending the profile toward its own local mean is a cheap,
    // convincing drape.
    const smoothed: Profile = (t) => {
      const [x0, y0] = base(t);
      const [xa, ya] = base(t + 0.035);
      const [xb, yb] = base(t - 0.035);
      let mx = (x0 * 0.5 + xa * 0.25 + xb * 0.25);
      let my = (y0 * 0.5 + ya * 0.25 + yb * 0.25);
      // Shoulder yoke. The torso's trapezius ramp now reaches the acromion on
      // its own (see Body.ts `torsoProfile`), so this is a few millimetres of
      // drape over the shoulder seam — NOT the 42 % inflation it used to be.
      // That inflation put the jersey's shoulder edge 4 cm outboard and 3 cm
      // above the deltoid, which is a plate with a crease along it: the
      // shoulder facet, in one line of code.
      const yoke = smooth(0.62, 0.95, u) * smooth(1.09, 0.99, u);
      if (yoke > 0) mx *= 1 + yoke * 0.045 * Math.pow(Math.abs(Math.cos(t * Math.PI * 2)), 0.8);
      /**
       * THE SHOULDER SEAM LAP — measured, not guessed.
       *
       * On the reference 1.80 m athlete the trapezius collapses from 196 mm
       * half-width at the acromion (y 1.472) to 84 mm at the neck root (y 1.502):
       * 11 cm of lateral travel across 3 cm of rise. The sleeve's cap crown sits
       * in the middle of that collapse — 185 mm out at y 1.490 — where the shell
       * underneath it has already fallen back to 154 mm. Three centimetres apart,
       * facing each other, at forty degrees: that is a wedge nothing can light,
       * and it is the black notch sitting on the point of every shoulder in every
       * closeup ever captured of this rig.
       *
       * A real shirt does not fall away from its own sleeve there, because the
       * two are sewn together. Carrying the panel back out over the cap for the
       * three loops that straddle it makes the surfaces INTERSECT, and an
       * intersection has no wedge in it. It is narrow in azimuth (the sleeve
       * subtends about ±35° of the loop) and it is gone by the neck root, so it
       * cannot become the shoulder shelf this file has twice been rid of.
       *
       * THE SIZE OF THE LAP IS MEASURED, TOO, and 0.40 was over it. The panel
       * under the cap is 154 mm out and the cap crown is 185 mm out, so the lap
       * that makes them intersect is 1.20 — at 1.40 the shell arrives 31 mm
       * PAST the sleeve and becomes a fin standing proud of it, with its own
       * underside in shadow. That is not a closed seam, it is the same black
       * wedge one shell further out, and it is what has been sitting on the
       * point of the shoulder in the hero crop.
       *
       * The window is also wider than the 16 mm of torso it used to occupy.
       * Five loops now carry a share of the swell instead of one carrying all
       * of it, which is the difference between a shoulder seam and a flange.
       */
      const seamLap = smooth(0.986, 1.012, u) * smooth(1.054, 1.024, u);
      if (seamLap > 0) {
        mx *= 1 + seamLap * 0.21 * Math.pow(Math.abs(Math.cos(t * Math.PI * 2)), 2.2);
      }
      /**
       * CLOTH BRIDGES A HOLLOW; IT NEVER SINKS INTO THE BODY.
       *
       * The three-tap blend above is a drape approximation, and a blend is only
       * one-sided where the surface is convex. Body.ts now carries a
       * supraclavicular fossa — two w = 0.055 lobes at amp −0.115, about 18 mm
       * deep on a 0.16 m section — and a section power of 2.55 across the
       * shoulder girdle, which is very nearly a slab with corners. Averaging
       * across either of those pulls the sampled radius BELOW the body's own:
       * measured either side of the fossa the blend lost 5–7 mm against a cloth
       * offset of 8.8 mm, so the jersey passed through the athlete and the
       * closeup rendered two patches of bare chest flanking the throat, plus a
       * skin wash over both shoulder tops.
       *
       * Clamping the blended radius to the anatomical one keeps every bridge the
       * blend was written for — a hollow still fills, because filling raises the
       * radius — and removes the only direction in which it can be wrong.
       */
      const r0 = Math.hypot(x0, y0);
      const rm = Math.hypot(mx, my);
      if (rm > 1e-6 && rm < r0) { const s = r0 / rm; mx *= s; my *= s; }
      const len = Math.hypot(mx, my) || 1e-6;
      // The fold rides the STANDOFF, so no amplitude can put cloth inside skin.
      // The floor is 3 mm, which is thinner than the garment and exists only so
      // a pathological tuning cannot close the gap entirely.
      const k = Math.max(nominal * (1 + jerseyFold(u, t).rel) + extra, 0.0030)
        * (H / 1.8);
      return [mx + (mx / len) * k, my + (my / len) * k];
    };
    return {
      o: torsoCentre(a, u), ax: V(1, 0, 0), az: V(0, 0, 1),
      r: smoothed,
      off: scoopAt(u),
      skin: torsoSkin(a, u, 0),
      // Verbatim. `torsoSkin` already carries the shoulder-corner clavicle
      // blend and the hip's femur term; anything added here is weight the chest
      // under the cloth does not have.
      skinAt: (t: number) => torsoSkin(a, u, t),
      v: clamp01((u - hemU) / (TORSO_TOP_U + 0.02 - hemU)),
      // The fold's own occlusion goes in here rather than being left to the
      // shading model. A trough between two folds is a slot a few millimetres
      // wide, and no lighting rig resolves the bounce inside one — but the
      // trough is exactly where the eye looks to decide whether it is looking at
      // cloth. Baking it is the difference between a fold and a ripple.
      crease: (t: number) => clamp01(0.30 * smooth(0.06, -0.075, u)
        + 0.25 * lobe(t, 0.25, 0.10) * smooth(0.55, 0.30, u)
        + 0.62 * jerseyFold(u, t).shade),
    };
  };

  const rings: Ring[] = [];
  // Hem fold: a ring turned back under itself so the jersey has a visible inside
  // edge instead of a knife-thin boundary.
  if (d.clothFold) {
    rings.push({ ...shellRing(hemU + 0.035, -0.0055), v: 0 });
    rings.push({ ...shellRing(hemU + 0.010, -0.0015), v: 0.01 });
  }
  for (const u of us) rings.push(shellRing(u));

  // Collar — a short rib band riding the same scoop as the loop under it, so it
  // is a continuation of the garment rather than a disc laid on top of one.
  const topO = torsoCentre(a, TORSO_TOP_U);
  const sTop = scoop(TORSO_TOP_U);
  const collar = (ra: number, rb: number, dy: number, k: number, v: number, cr: number): Ring => ({
    o: V(0, topO.y + dy * H, topO.z), ax: V(1, 0, 0), az: V(0, 0, 1),
    r: ellipse(a.g.neckA * ra, a.g.neckB * rb),
    off: (t: number) => sTop * k * neckWin(t),
    skin: sk2(bi('chest'), 0.42, bi('neck'), 0.58),
    v, crease: cr,
  });
  rings.push(collar(1.230, 1.190, 0.0036, 1.00, 0.975, 0.15));
  rings.push(collar(1.170, 1.132, 0.0095, 1.015, 0.998, 0.16));
  if (d.clothFold) {
    // The rib turns back INSIDE ITSELF and lands on the neck. At 1.116 / 1.146
    // of the neck section the returning band closed on a 6–8 mm annulus facing
    // straight up the collar, lit by nothing, which renders as a black notch
    // beside the throat in every closeup — the same defect as the sleeve hem,
    // one garment up. A crew rib sits ON the neck; 1.06 is a rib's own
    // thickness away from it.
    rings.push(collar(1.062, 1.030, 0.0078, 1.015, 1.0, 0.55));
    rings.push(collar(1.092, 1.056, 0.0034, 1.00, 1.0, 0.75));
  }

  m.group(GROUP.jersey).loft(rings, seg, { part: PART.JERSEY, side: 0 });

  /* ------------------------------------------------------------ sleeves */
  /**
   * THE SLEEVE IS A PARALLEL OFFSET OF THE ARM — nothing more.
   *
   * `armSurface()` hands back the exact ring frame the skin loft used, grown by
   * a cloth thickness. Because the two surfaces differ only by that constant,
   * the sleeve's silhouette is the deltoid's silhouette, and the shoulder can
   * no longer crease away from the arm inside it. The old sleeve authored its
   * own radius curve at 1.34 × the deltoid and its own tilted cap, and the
   * mismatch between the two is what the critic saw as a faceted ridge.
   *
   * It also runs the SAME six loops across the cap that the arm does, so there
   * is no place for the two to disagree about where the shoulder is.
   */
  const sleeveEnd = d.level === 0 ? 0.52 : 0.50;
  const CLOTH = 0.0072 * (H / 1.8);
  const ring = armSurface(a);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const UA = bi(`upperArm${suf}` as BoneName);
    const UT = bi(`upperArmTwist${suf}` as BoneName);
    /**
     * The two places a short sleeve actually gathers, as a multiple of the cloth
     * thickness. Bounded well inside the standoff below, so the sleeve can no
     * more reach the arm than the shell can reach the ribs.
     */
    const pitT = si === 0 ? 0.10 : 0.40;
    const sleeveFold = (q: number, t: number): { rel: number; shade: number } => {
      // Cuff. The hem band is a denser knit than the panel feeding it, so the
      // surplus stacks into shallow flutes over the last four centimetres —
      // which is the one place a sleeve is ALWAYS creased and the one place this
      // sleeve was perfectly smooth.
      const cuff = smooth(sleeveEnd - 0.28, sleeveEnd - 0.03, q);
      const c = 0.5 - 0.5 * Math.cos(Math.PI * 2 * (t * 5 + 0.18));
      let rel = 0.30 * cuff * c;
      let shade = 0.26 * cuff * (1 - c);
      // …and the band GRIPS. A sleeve hem is a doubled, denser knit under
      // tension; it is the one loop of the whole garment that is closer to the
      // arm than the panel above it, and leaving it at the panel's own 12 mm of
      // drape is what made the cuff stand off the bicep as a bell with a black
      // annulus inside it — read on the hero crop as a strap round the arm
      // rather than as the end of a sleeve.
      rel -= 0.55 * smooth(sleeveEnd - 0.11, sleeveEnd, q);
      // Underarm. The arm carried at the side pushes the panel into the pit.
      const pit = smooth(-0.05, 0.14, q) * smooth(0.58, 0.26, q) * lobe(t, pitT, 0.13);
      rel -= 0.48 * pit;
      shade += 0.45 * pit;
      return { rel, shade };
    };
    const qs = d.level === 0
      ? [-0.335, -0.305, -0.265, -0.215, -0.155, -0.088, -0.015, 0.10, 0.24, 0.38, sleeveEnd]
      : d.level === 1
        ? [-0.335, -0.28, -0.19, -0.09, 0.02, 0.22, sleeveEnd]
        : [-0.335, -0.22, -0.06, 0.16, sleeveEnd];
    const sr: Ring[] = [];
    const push = (q: number, extra: number): Ring => {
      // Cloth hangs a little away from the arm below the deltoid and is pulled
      // tight over it, which is also what stops the sleeve reading as paint.
      // 7 mm across the deltoid, 12 mm by the cuff.
      //
      // The extra above the joint is the sleeve's half of the shoulder lap. The
      // jersey shell comes out to meet it (see `off` above) and this comes up to
      // meet the shell; between them the two surfaces cross instead of grazing,
      // and the black V that used to sit on the point of the shoulder has no
      // volume left to live in.
      // Kept small on purpose. The shell and the sleeve bind through DIFFERENT
      // functions where they overlap — `torsoSkin`'s clavicle corner against
      // `armSkin`'s deltoid cap — so a raised arm slides the sleeve outboard of
      // the panel it is sewn to. Every millimetre of cap inflation is a
      // millimetre more of that slip, so the lap that closes the seam belongs on
      // the SHELL (see `seamLap` above) and only a token of it here.
      const lap = CLOTH * 0.55 * smooth(0.04, -0.26, q);
      // 0.73 put 12 mm of air between the cuff and the bicep. A short sleeve on
      // a fitted athletic cut hangs about 7; the extra five were the volume the
      // black annulus at the hem was living in.
      const drape = extra + lap + CLOTH * (0.92 + 0.28 * smooth(0.05, 0.50, q));
      const R = ring(si, q, drape);
      // Cloth bridges muscle detail rather than following it into the valleys.
      const soft = R.lobes.map((L) => ({ ...L, amp: L.amp * 0.45 }));
      const shape = ellipse(R.ra, R.rb, soft);
      const wrinkled: Profile = (t: number) => {
        const [x, y] = shape(t);
        const len = Math.hypot(x, y) || 1e-6;
        const f = CLOTH * sleeveFold(q, t).rel;
        return [x + (x / len) * f, y + (y / len) * f];
      };
      return {
        o: R.o, ax: R.ax, az: R.az,
        r: wrinkled,
        // The arm's OWN binding, evaluated at the same q. The sleeve is a
        // parallel offset of `armSurface` and must be a parallel offset of its
        // skinning too, or the deltoid swings out through it.
        skin: armSkin(a, si, q, 0),
        skinAt: (t: number) => armSkin(a, si, q, t),
        v: clamp01((q + CAP_Q) / (sleeveEnd + CAP_Q)),
        crease: (t: number) => clamp01(0.12 + 0.28 * smooth(0.28, 0.52, q)
          + 0.55 * sleeveFold(q, t).shade),
      };
    };
    for (const q of qs) sr.push(push(q, 0));
    if (d.clothFold) {
      /**
       * Hem turned back under itself so the sleeve has a readable inside edge —
       * and the return has to arrive AT THE ARM, not 7 mm off it.
       *
       * The panel drape at the cuff is 1.70 × CLOTH ≈ 12 mm. The turn-back used
       * to subtract 3.0 and 5.2 mm of that, so the fold closed on a 7 mm annulus
       * whose inner wall faces up the sleeve and is therefore lit by nothing at
       * all. Seven millimetres is ten pixels at the hero framing, and ten pixels
       * of pure black wrapped round a bicep is not a hem, it is a strap.
       *
       * The two numbers below are the drape less about 2 mm, so the returning
       * lip lands a garment-thickness off the skin: the slot is still there —
       * you can see into the sleeve, which is the whole point of modelling the
       * fold — but it is 2 mm deep instead of 7.
       */
      sr.push(push(sleeveEnd - 0.010, -0.0020));
      sr.push(push(sleeveEnd - 0.050, -0.0046));
    }
    // Same reason as the shell: five flutes round a sleeve need twenty-odd
    // columns before they stop being a pentagon.
    m.group(GROUP.jersey).loft(sr, Math.max(10, d.level === 0
      ? Math.round(d.limbSegs * 1.5) : d.limbSegs), {
      part: PART.JERSEY, side: s, capStart: true,
    });
  }
}

/* ----------------------------------------------------------------- shorts */

/**
 * THE CROTCH — a real Y-junction, not three surfaces hoping to overlap.
 *
 * What was there: a waistband tube, two thigh tubes pushed up inside it, and a
 * cone ("the bowl") shrinking the waistband's bottom loop to a point at the
 * crotch. Every one of those three pieces failed, and they failed for the same
 * reason — a stack of horizontal loops cannot describe a tube that splits.
 *   • The thigh tubes started 7 cm ABOVE the hip joint, where the waistband is
 *     still a waist: their top loops stood 3.5 cm proud of it, so each leg
 *     emerged from the side of the shorts as a flat open-ended sleeve. That is
 *     the pair of hard trapezoidal flaps in every hip-height frame.
 *   • The bowl swept 18 cm of lateral travel across 5 cm of drop, so its outer
 *     half was a horizontal blade hanging in mid-air outboard of both legs.
 *   • Its last loop was fan-capped: a flat downward disc at the inseam. THE
 *     NOTCH.
 *
 * What is there now is how a pair of trousers is actually built. The waistband
 * is one closed tube down to a split loop 3 cm above the crotch. Its bottom
 * opening is divided by a CROTCH SEAM — a chord of shared vertices running from
 * the front midline, dipping to 0.485 H under the body, to the back midline —
 * and each half of that opening continues into a leg. The seam vertices belong
 * to both legs, so the inseam is continuous by construction: there is no overlap
 * to misjudge and no cap to see. Below the junction each leg morphs from its
 * half of the hip section into a round tube over 5 cm, and the hem is a full
 * ellipse at every loop, so it falls as a cylinder round each thigh.
 *
 * The medial faces are still softly clamped a few millimetres off the midline
 * between crotch and mid-thigh — two planes facing each other meet tangentially,
 * two cylinders meet in a V — and the clamp releases toward the hem, where the
 * legs are furthest apart and the hem has to stay round.
 */
export function buildShorts(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const S4 = H / 1.8;
  const g = a.g;
  // Waist loop segments, forced to a multiple of four: the front, back and both
  // lateral points must be real vertices, because the crotch seam is anchored on
  // the front and back ones and the split is anchored on all four.
  const S = Math.max(12, 4 * Math.round(d.torsoSegs / 4));
  // Seam vertices, front to back inclusive. S/2 + 1 makes every leg loop exactly
  // S vertices at a uniform angular step — the leg tube below the junction is a
  // plain S-segment cylinder with no coarse patch on the inside of the thigh.
  const M = S / 2 + 1;

  const waistU = 0.30;
  const crotchY = 0.485 * H;
  const ySplit = crotchY + 0.017 * H;
  const uSplit = (ySplit - a.hipY) / a.torsoSpan;
  const hem = d.level === 0 ? 0.46 : 0.44;
  const K = 0.0165 * S4;

  /* ------------------------------------------------------- leg geometry */
  const legAxes = (si: number) => {
    const dir = a.legDir[si];
    const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
    const ax = new THREE.Vector3().crossVectors(dir, az);
    return { dir, ax, az };
  };
  const legO = (si: number, q: number) =>
    a.hip[si].clone().addScaledVector(a.legDir[si], a.len.thigh * q);
  const legRad = curve([
    [-0.05, g.thighA * 1.02], [0.12, g.thighA * 0.99],
    [0.30, g.thighA * 0.93], [0.52, g.thighA * 0.86],
  ]);
  const legR = (q: number) => legRad(q) + lerp(0.0125, 0.0205, smooth(0.02, 0.44, q)) * S4;
  const legDeep = g.thighB / g.thighA;

  // q at which a leg loop sits at the split height, and how wide the waistband
  // must be there to contain both of them. The waistband is derived FROM the
  // legs, which is the invariant the old code lacked.
  const qSplit = clamp01((a.hipY - ySplit)
    / Math.max(1e-4, a.len.thigh * Math.abs(a.legDir[0].y)));
  const Wlow = Math.abs(legO(0, qSplit).x) + legR(qSplit);

  /* ---------------------------------------------------------- waistband */
  const latAt = (u: number) => Math.abs(torsoProfile(a, u)(0)[0]);
  const fxLow = Wlow / Math.max(1e-4, latAt(uSplit) + K);
  /**
   * THE FRONT RISE. The split loop is horizontal at ySplit, 3 cm above the
   * crotch, and the two legs part company at whatever height it hands them over
   * — so with a flat loop they parted 3 cm too high, and everyone looking at the
   * athlete from the front saw a dark wedge of gusset through the gap. On a real
   * pair of shorts the fabric on the midline runs all the way down to the crotch
   * and the legs only separate below it. `Ring.off` drops the loop's front and
   * back midlines to the crotch while the sides stay up at the leg openings,
   * which is that shape exactly, in one loop.
   */
  const rise = (u: number) => (ySplit - crotchY - 0.0030 * H) * smooth(0.07, uSplit, u);
  const riseAt = (u: number) => {
    const s = rise(u);
    if (s < 1e-5) return undefined;
    return (t: number) => s * (win(t, 0.25, 0.115) + 0.94 * win(t, 0.75, 0.130));
  };
  const yoke = (u: number, extra = 0): Ring => {
    const base = torsoProfile(a, u);
    /**
     * THE TUCK.
     *
     * The waistband is 18 cm of garment that nobody ever sees: the jersey hem
     * ends at `JERSEY_HEM_U`, well below it, so everything above that line is
     * under the shirt and the only thing it can do up there is fight it. And it
     * did — laterally the two shells were 3 mm apart over the trochanter, which
     * a pose or a fold closes instantly, and the shorts came through the shirt
     * as a hard navy wedge across the hip in every frame that includes a waist.
     *
     * Drawing the hidden band in to 40 % of its thickness puts 7 mm of air back
     * between them and costs nothing, because the band it thins is the band that
     * is not in the picture. The ramp completes BELOW the hem so the waistband is
     * already at full section by the time it emerges.
     */
    const tuck = lerp(1, 0.40, smooth(JERSEY_HEM_U - 0.030, JERSEY_HEM_U + 0.090, u));
    const k = (K + extra * S4) * tuck;
    // Shorts drape over the trochanters and the tops of the thighs, so the lower
    // loops widen laterally to the leg envelope and no further — and the widening
    // now starts below the hem too, for the same reason.
    const fx = lerp(1, fxLow, smooth(JERSEY_HEM_U + 0.125, uSplit, u));
    return {
      o: torsoCentre(a, u),
      ax: V(1, 0, 0), az: V(0, 0, 1),
      off: riseAt(u),
      r: (t: number) => {
        const [x0, y0] = base(t);
        const len = Math.hypot(x0, y0) || 1e-6;
        return [(x0 + (x0 / len) * k) * fx, y0 + (y0 / len) * k];
      },
      skin: torsoSkin(a, u, 0),
      // Verbatim, same reason as the jersey shell — `torsoSkin` already hands
      // the hip ring over to the femurs below u = 0.06.
      skinAt: (t: number) => torsoSkin(a, u, t),
      v: clamp01((waistU - u) / (waistU - uSplit)) * 0.35,
      crease: 0.15 + 0.30 * smooth(0.05, uSplit, u),
    };
  };

  const us = d.level === 0
    ? [waistU, 0.245, 0.19, 0.135, 0.082, 0.032, -0.014, -0.055, uSplit]
    : d.level === 1 ? [waistU, 0.20, 0.09, -0.01, uSplit] : [waistU, 0.10, uSplit];
  const rings: Ring[] = [];
  if (d.clothFold) {
    rings.push({ ...yoke(waistU - 0.055, -0.006), v: 0 });
    rings.push({ ...yoke(waistU - 0.018, -0.002), v: 0.01 });
  }
  for (const u of us) rings.push(yoke(u));

  m.group(GROUP.shorts);
  // `flip`, because this stack runs DOWNWARD while every other ax = +X loft in
  // the rig (torso, jersey) runs upward, and the winding follows the stacking
  // direction. Without it the waistband's normals point at the athlete: the
  // garment is backface-culled away entirely and what the camera sees through
  // the hole is the athlete's own hip, plus the inside of the far wall of the
  // shorts as a pale sheet and the inverted crotch as a black wedge. That is
  // the single defect behind most of what the shorts looked like.
  const base = m.loft(rings, S, { part: PART.SHORTS, side: 0, flip: true });
  // Last row of the loft — the split loop. `loft` writes S + 1 columns per row
  // (the last duplicates the first for uv), so column j < S is the real vertex.
  const rowBase = base + (rings.length - 1) * (S + 1);
  const wv = (j: number) => rowBase + (((j % S) + S) % S);

  const split = rings[rings.length - 1];
  const PF = ringPoint(split, 0.25);      // front midline of the split loop
  const PB = ringPoint(split, 0.75);      // back midline

  /* -------------------------------------------------------- crotch seam */
  // Weighted pelvis-dominant with a share of each femur: a 66° stride swings one
  // leg without dragging the seam off the other.
  const seamSkin = skN([[bi('pelvis'), 0.46], [bi('thigh_L'), 0.27], [bi('thigh_R'), 0.27]]);
  const cs: number[] = new Array(M);
  const csP: Vec3[] = new Array(M);
  cs[0] = wv(3 * S / 4); csP[0] = PB;
  cs[M - 1] = wv(S / 4); csP[M - 1] = PF;
  for (let mi = 1; mi <= M - 2; mi++) {
    const z = mi / (M - 1);
    // A soft-shouldered bump, not a wedge: the exponent under 1 leaves the seam
    // dropping almost vertically out of the front and back midlines, so the
    // inseam reads as an arch and never as the V it used to be.
    const dip = Math.pow(Math.sin(Math.PI * z), 0.62);
    const p = V(
      0,
      lerp(lerp(PB.y, PF.y, z), crotchY, dip),
      lerp(PB.z, PF.z, z) * (1 - 0.26 * dip),
    );
    csP[mi] = p;
    cs[mi] = m.vert(p, 0.5, 0.35, seamSkin, PART.SHORTS, 0, 0.55 + 0.35 * dip, 0.35);
  }

  /* ------------------------------------------------------------- legs */
  /**
   * Half the slot the two clamped medial faces leave between them — and it must
   * be ZERO immediately under the crotch. Holding the tubes 1.4 cm apart there
   * left a slot you could see into: the medial walls, the seam above them and
   * the athlete's own skin behind, all of it facing sideways in full shadow,
   * which renders as a hard black wedge sitting in the inseam. Real inner
   * thighs touch at the crotch and part lower down, so the clamp now ramps IN
   * as the legs separate rather than out.
   */
  const GAP = 0.0105 * S4;
  const SOFT = 0.020 * S4;
  /** One-sided soft clamp — C1 at the join, asymptotic at the limit, so the
   *  flattened medial face blends into the round part with no crease. */
  const softLo = (x: number, lim: number): number => {
    const dd = x - (lim - SOFT);
    return dd <= 0 ? x : lim - SOFT * Math.exp(-dd / SOFT);
  };

  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const TH = bi(`thigh${suf}` as BoneName);
    const TT = bi(`thighTwist${suf}` as BoneName);
    // Rotate the loop's index origin onto the MEDIAL side so the duplicated uv
    // seam column hides between the thighs on both legs.
    const rot = si === 0 ? 0 : S / 2;

    /** Junction-loop vertex for slot k (τ = k/S around the leg). */
    const juncV = (k: number): number => {
      const arc = si === 0
        ? (k >= S / 4 && k <= 3 * S / 4)
        : (k <= S / 4 || k >= 3 * S / 4);
      if (arc) return wv(S / 2 - k);
      return si === 0
        ? cs[(((k - 3 * S / 4) % S) + S) % S]
        : cs[3 * S / 4 - k];
    };
    const juncP = (k: number): Vec3 => {
      const arc = si === 0
        ? (k >= S / 4 && k <= 3 * S / 4)
        : (k <= S / 4 || k >= 3 * S / 4);
      if (arc) return ringPoint(split, ((((S / 2 - k) % S) + S) % S) / S);
      return si === 0
        ? csP[(((k - 3 * S / 4) % S) + S) % S]
        : csP[3 * S / 4 - k];
    };

    /** The leg's own round section at chain parameter q, angle τ. */
    const legPt = (q: number, tau: number, out: Vec3): Vec3 => {
      const { ax, az } = legAxes(si);
      const o = legO(si, q);
      const rr = legR(q);
      const th = tau * Math.PI * 2;
      const x0 = rr * Math.cos(th);
      const y0 = rr * legDeep * Math.sin(th);
      const clamped = smooth(qSplit + 0.02, qSplit + 0.17, q)
        * lerp(1, 0.55, smooth(0.30, hem, q));
      let xc = x0;
      if (clamped > 0.01) {
        // `ax` points at −X on both sides, so world x ≈ o.x − x0.
        const lim = s > 0 ? o.x - GAP : o.x + GAP;
        const cl = s > 0 ? softLo(x0, lim) : -softLo(-x0, -lim);
        xc = lerp(x0, cl, clamped);
      }
      return out.copy(o).addScaledVector(ax, xc).addScaledVector(az, y0);
    };

    /**
     * The thigh's own binding. `qSplit` lands at q ≈ 0.114 — well BELOW the
     * body's hip cap, which releases at q = 0.06 — so every loop of this tube
     * covers a stretch of femur that is bound essentially 100 % to the femur.
     * The old `waistSkin` held it at 80 % pelvis for the whole tube, which is a
     * near-total disagreement with the leg inside it: 66° of hip flexion swung
     * the thigh straight through the shorts, and that is why the shorts read as
     * detached rings on the running players rather than as a garment.
     */
    const legSkinAt = (q: number, t: number): Skin => legSkin(a, si, q, t);

    /* junction loop — shared vertices, so the inseam cannot open */
    const junction: number[] = [];
    for (let i = 0; i <= S; i++) {
      if (i === S) {
        const p = juncP(rot % S);
        const dup = m.vert(p, 1, 0.35, seamSkin, PART.SHORTS, s, 0.5, 0.35);
        junction.push(dup);
        m.seam(junction[0], dup);
      } else junction.push(juncV((i + rot) % S));
    }

    const qs = d.level === 0
      ? [qSplit + 0.026, qSplit + 0.058, qSplit + 0.098, 0.255, 0.315, 0.380, hem]
      : d.level === 1 ? [qSplit + 0.045, qSplit + 0.11, 0.28, 0.38, hem]
        : [qSplit + 0.07, 0.30, hem];
    // Hem turned back under itself, so the shorts have a readable inside edge
    // instead of a knife-thin boundary. The number is a fraction of the loop's
    // own radius, which keeps the fold proportional across the roster.
    const folds: [number, number][] = d.clothFold
      ? [[hem - 0.012, 0.050], [hem - 0.052, 0.092]] : [];

    const tmp = V();
    let prev = junction;
    const emit = (q: number, shrink: number, vv: number): void => {
      const beta = smooth(qSplit, qSplit + 0.085, q);
      const drop = a.len.thigh * (q - qSplit);
      const cr = clamp01(0.22 * smooth(qSplit + 0.10, qSplit - 0.06, q)
        + 0.18 * smooth(0.22, 0.46, q));
      const row: number[] = [];
      for (let i = 0; i <= S; i++) {
        const k = (i + rot) % S;
        legPt(q, k / S, tmp);
        if (shrink !== 0) {
          // Hem turn-back: pull the loop toward its own centre.
          const c = legO(si, q);
          tmp.lerp(c, shrink);
        }
        if (beta < 0.999) {
          // Morph out of the athlete's hip section into a round thigh tube.
          const j = juncP(k).clone().addScaledVector(a.legDir[si], drop);
          tmp.lerpVectors(j, tmp, beta);
        }
        // Inseam shadow rides the medial face on both sides.
        const inseam = 0.42 * lobe(k / S, si === 0 ? 0 : 0.5, 0.11)
          * smooth(qSplit + 0.02, qSplit + 0.12, q);
        row.push(m.vert(tmp, i / S, vv, legSkinAt(q, k / S), PART.SHORTS, s,
          clamp01(cr + inseam), vv));
      }
      m.seam(row[0], row[S]);
      for (let j = 0; j < S; j++) m.quad(prev[j], row[j], row[j + 1], prev[j + 1]);
      prev = row;
    };

    for (const q of qs) {
      emit(q, 0, 0.35 + 0.65 * clamp01((q - qSplit) / (hem - qSplit)));
    }
    for (const [q, sh] of folds) emit(q, sh, 1);
  }
}

/* ------------------------------------------------------------------ socks */

export function buildSocks(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const g = a.g;
  const H = a.H;
  const rad = curve([
    [1.30, g.calfA * 1.01], [1.40, g.calfA * 0.99], [1.60, g.calfA * 0.72],
    [1.80, g.ankleA * 1.14], [1.99, g.ankleA * 0.98],
  ]);
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const SH = bi(`shin${suf}` as BoneName);
    const FO = bi(`foot${suf}` as BoneName);
    const top = 1.34;
    const qs = d.level === 0 ? [top, 1.44, 1.56, 1.68, 1.80, 1.90, 1.99]
      : d.level === 1 ? [top, 1.52, 1.74, 1.99] : [top, 1.65, 1.99];
    const ring = (q: number, extra: number): Ring => {
      const dir = a.shinDir[si];
      const az = V(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
      const ax = new THREE.Vector3().crossVectors(dir, az);
      const rr = rad(q) + (0.0048 + extra) * (H / 1.8);
      const r2 = clamp01((q - 1) );
      return {
        o: a.knee[si].clone().addScaledVector(dir, a.len.shin * (q - 1)),
        ax, az,
        r: ellipse(rr, rr * (g.calfB / g.calfA), [
          { at: 0.75, w: 0.18, amp: 0.10 * smooth(1.60, 1.30, q) },
        ]),
        skin: sk2(SH, 1 - smooth(1.90, 2.0, q) * 0.65, FO, smooth(1.90, 2.0, q) * 0.65),
        v: r2,
        crease: 0.12 + 0.30 * smooth(1.42, 1.34, q),
      };
    };
    const rs: Ring[] = [];
    if (d.clothFold) {
      // Ribbed cuff — two turns, which is what makes a sock read as knitwear.
      rs.push(ring(top + 0.055, -0.0030));
      rs.push(ring(top + 0.022, 0.0018));
      rs.push(ring(top + 0.004, 0.0026));
    }
    for (const q of qs) rs.push(ring(q, smooth(1.40, 1.34, q) * 0.0022));
    m.group(GROUP.socks).loft(rs, Math.max(8, d.limbSegs - 2), { part: PART.SOCK, side: s });
  }
}

/* ------------------------------------------------------------------ shoes */

/**
 * Cleat last, metres at H = 1.80, measured forward from the ankle joint. A foot
 * is 0.153 H long with the ankle a quarter of the way back from the heel, so the
 * shoe runs −0.070 to +0.232 — nearly 30 cm. The first pass had it at 17 cm and
 * 10 cm wide, which is a paddle, and it read as one instantly.
 */
const SHOE_Z = [-0.0700, -0.0500, -0.0200, 0.0150, 0.0550, 0.1000, 0.1450, 0.1900, 0.2320];
const SHOE_W = [0.48, 0.78, 0.90, 0.97, 1.00, 0.99, 0.91, 0.72, 0.34];
const SHOE_TOP = [0.0530, 0.0760, 0.0900, 0.0820, 0.0700, 0.0590, 0.0480, 0.0360, 0.0250];
const SHOE_SOLE = [0.0100, 0.0058, 0.0036, 0.0028, 0.0026, 0.0028, 0.0034, 0.0044, 0.0068];

export function buildShoes(m: RigMesh, a: Anthro, d: DetailSpec): void {
  const H = a.H;
  const g = a.g;
  const footW = g.ankleA * 1.36;
  const seg = d.level === 0 ? 14 : d.level === 1 ? 10 : 7;
  for (let si = 0; si < 2; si++) {
    const s = SIDES[si];
    const suf = SIDE_SUFFIX[si];
    const FO = bi(`foot${suf}` as BoneName);
    const TO = bi(`toe${suf}` as BoneName);
    const cx = a.ankle[si].x;
    const cz = a.ankle[si].z;
    const ballZ = a.ball[si].z;
    const rings: Ring[] = [];
    const step = d.level === 2 ? 2 : 1;
    for (let i = 0; i < SHOE_Z.length; i += step) {
      const zz = cz + SHOE_Z[i] * (H / 1.8);
      const top = SHOE_TOP[i] * (H / 1.8);
      const sole = SHOE_SOLE[i] * (H / 1.8);
      const w = footW * SHOE_W[i];
      const hh = (top - sole) * 0.5;
      const yc = (top + sole) * 0.5;
      const toeF = smooth(ballZ - 0.01 * H, ballZ + 0.03 * H, zz);
      rings.push({
        o: V(cx + s * 0.002 * H, yc, zz),
        ax: V(1, 0, 0), az: V(0, 1, 0),
        r: ellipse(w, hh, [
          // Outsole flare + a lace-panel dip along the top of the instep.
          { at: 0.75, w: 0.16, amp: 0.16 },
          { at: 0.25, w: 0.10, amp: -0.10 * smooth(-0.03 * H, 0.02 * H, zz - cz) },
        ], 2.45),
        skin: sk2(FO, 1 - toeF, TO, toeF),
        v: i / (SHOE_Z.length - 1),
        crease: (t: number) => 0.15 + 0.45 * lobe(t, 0.75, 0.12),
      });
    }
    m.group(GROUP.shoes).loft(rings, seg, {
      part: PART.SHOE, side: s, capStart: true, capEnd: true, flip: true,
    });

    if (d.level !== 0) continue;
    // Studs. Eight cones under the plate: five around the forefoot, three at the
    // heel. They exist for one frame — the layout — and they are the difference
    // between a cleat and a slipper.
    const studs: [number, number][] = [
      [-0.62, -0.055], [0.62, -0.055], [-0.56, -0.020], [0.56, -0.020],
      [-0.70, 0.070], [0.70, 0.070], [-0.62, 0.135], [0.62, 0.135], [0.0, 0.175],
    ];
    for (const [sx, sz] of studs) {
      const zz = cz + sz * (H / 1.8);
      const iw = footW * (0.86 + 0.12 * Math.cos(sz * 20));
      const px = cx + sx * iw;
      const base = 0.0026 * (H / 1.8);
      const sr: Ring[] = [];
      for (let k = 0; k < 3; k++) {
        const u = k / 2;
        sr.push({
          o: V(px, base - u * 0.0075 * (H / 1.8), zz),
          ax: V(1, 0, 0), az: V(0, 0, 1),
          r: ellipse(0.0042 * (H / 1.8) * (1 - 0.45 * u), 0.0042 * (H / 1.8) * (1 - 0.45 * u)),
          skin: sk2(FO, sz < 0.02 ? 1 : 0.2, TO, sz < 0.02 ? 0 : 0.8),
          v: u, crease: 0.3,
        });
      }
      m.group(GROUP.shoes).loft(sr, 5, { part: PART.SHOE, side: s, capEnd: true, flip: true });
    }
  }
}
