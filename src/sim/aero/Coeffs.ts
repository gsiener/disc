/**
 * Aerodynamic + inertial constants for a 175 g Ultimate disc, and the
 * coefficient curves that drive DiscPhysics.
 *
 * Conventions used everywhere in src/sim/aero and src/sim/DiscPhysics.ts:
 *
 *   BODY FRAME   body +Z is the disc normal (the spin axis, "up" out of the
 *                top plate).  body +X / +Y lie in the disc plane.  The disc is
 *                axisymmetric so the phase of +X about +Z is physically
 *                irrelevant; only the normal matters.
 *
 *   AERO FRAME   built fresh each step from the relative wind:
 *                  xa = unit( v_rel projected into the disc plane )  "flight axis"
 *                  ya = xa x n                                       "pitch axis"
 *                  n  = disc normal
 *                A positive pitching-moment coefficient CM is NOSE UP.
 *                A positive rolling-moment coefficient CR is a right-hand
 *                torque about xa.
 *
 *   ALPHA        angle of attack = angle between the relative wind and the
 *                disc plane, positive when the air hits the underside
 *                (nose up).  alpha = atan2(-v_rel.n, |v_rel in plane|).
 *
 * Coefficient magnitudes follow published wind-tunnel fits for a 175 g disc
 * (Hummel; Potts & Crowther), with two additions the published fits do not
 * cover but a game needs: a smooth post-stall blend to flat-plate behaviour,
 * and a reversed-flow penalty for flying dome-first.
 *
 * ------------------------------------------------------------------ tuning
 * Three coefficients were calibrated against flight behaviour rather than
 * taken at face value.  The reasoning, so nobody has to rediscover it:
 *
 *  CLa 2.0 (not 1.4).  With CLa = 1.4 the model's best lift-to-drag ratio is
 *      1.89.  A real disc glides at 2.4-3.0, and a 20 m/s throw could only
 *      manage 27 m before it ran out of air.  2.0 gives peak L/D 2.26 and
 *      37 m, which is what a 20 m/s backhand actually does.  Published lift
 *      slopes for a Frisbee are 2.0-2.6 /rad, so 1.4 was the outlier.
 *
 *  CM0 -0.0035 (not -0.02).  The precession rate of the spin axis is
 *      |M| / (Izz * spin).  At 20 m/s with 52 rad/s of spin that is
 *      0.5*1.225*20^2*0.0568 * 0.273 * |CM| / (1.01e-3 * 52.4)
 *      = 71.8 * |CM| rad/s.  CM0 = -0.02 therefore rolls a flat disc at
 *      1.65 rad/s - onto its edge in under a second, every throw.  Real
 *      Ultimate discs turn over maybe 10-30 degrees across a whole huck.
 *      -0.0035 puts the zero-moment trim at alpha = 1.3 degrees, which is
 *      also what axisymmetry demands: a disc in axisymmetric flow at alpha=0
 *      can have no pitching moment about its own centre, so CM0 must be
 *      small.  CMa is left at the briefed 0.15.
 *
 *  CRr -0.0030.  Strip theory over the disc gives CRr = -CL/4 ~ -0.04, but
 *      that badly overpredicts because a disc is a very low-aspect-ratio
 *      wing whose circulation is set globally, not strip by strip.  Measured
 *      values are two orders smaller; -0.0030 puts the nose-up drift it
 *      causes at ~0.08 rad/s at 20 m/s, a real but secondary effect.
 */

export interface DiscBody {
  /** kg */
  mass: number;
  /** m */
  diameter: number;
  /** m */
  radius: number;
  /** m^2, planform */
  area: number;
  /** kg m^2, transverse (Ixx = Iyy) */
  Ixx: number;
  /** kg m^2, about the spin axis */
  Izz: number;
  /** m, half-thickness used for the ground contact plane */
  halfHeight: number;
}

export const DISC: DiscBody = {
  mass: 0.175,
  diameter: 0.273,
  radius: 0.1365,
  area: 0.0568,
  Ixx: 5.05e-4,
  Izz: 1.01e-3,
  halfHeight: 0.013,
};

export interface AeroCoeffs {
  /** kg/m^3 */
  rho: number;
  /** m/s^2, magnitude */
  g: number;

  /* lift: CL = CL0 + CLa * alpha (pre-stall) */
  CL0: number;
  CLa: number;

  /* drag: CD = CD0 + CDa * (alpha - alpha0)^2 (pre-stall) */
  CD0: number;
  CDa: number;
  alpha0: number;

  /* pitching moment: CM = CM0 + CMa * alpha + CMq * qhat */
  CM0: number;
  CMa: number;
  /** pitch-rate damping, negative */
  CMq: number;
  /** saturation half-width applied to alpha inside CM, rad */
  CMalphaSat: number;

  /* rolling moment: CR = CRr * rhat + CRp * phat
   * CRr < 0 encodes the advancing/retreating blade asymmetry in this frame:
   * the blade advancing into the wind makes more lift, which for a
   * right-hand-backhand disc (spin along -n) is a +xa torque. */
  CRr: number;
  /** roll-rate damping, negative */
  CRp: number;

  /* spin-axis moment: CN = CNr * rhat  (skin friction, negative) */
  CNr: number;

  /* post-stall blend */
  /** |alpha| at which separation starts, rad */
  aStall: number;
  /** blend width in |alpha|, rad */
  aStallWidth: number;
  /** fully separated lift peak, CL = CLplate * sin(2a) */
  CLplate: number;
  /** fully separated drag, CD = CD0 + CDplate * sin(a)^2 (1.10 -> CD ~1.18 face-on, a flat circular plate) */
  CDplate: number;

  /* Reversed flow. A disc is not symmetric: the domed top is cambered and the
   * bottom is an open cavity with a sharp rim. Below the zero-lift angle the
   * air arrives dome-first into the cavity's wake, the flow separates off the
   * rim immediately, and the disc loses most of its lift while its drag jumps.
   * This is why an upside-down disc falls out of the sky instead of gliding,
   * and it is what makes a hammer drop off the back end. */
  /** How far below the zero-lift alpha the reversal is complete, rad. */
  revWidth: number;
  /** Lift multiplier in fully reversed flow. */
  revLift: number;
  /** Drag multiplier in fully reversed flow. */
  revDrag: number;
}

export const AERO: AeroCoeffs = {
  rho: 1.225,
  g: 9.81,

  CL0: 0.15,
  CLa: 2.0,

  CD0: 0.08,
  CDa: 2.6,
  alpha0: -0.07,

  CM0: -0.0035,
  CMa: 0.15,
  CMq: -0.012,
  CMalphaSat: 0.7,

  CRr: -0.0030,
  CRp: -0.0055,

  CNr: -0.0045,

  aStall: 0.40,
  aStallWidth: 0.35,
  CLplate: 1.0,
  CDplate: 1.10,

  revWidth: 0.22,
  revLift: 0.15,
  revDrag: 2.2,
};

/* ------------------------------------------------------------------ curves */

function smoothstep01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/** 0 = fully attached, 1 = fully separated. */
export function stallBlend(alpha: number, c: AeroCoeffs = AERO): number {
  return smoothstep01((Math.abs(alpha) - c.aStall) / c.aStallWidth);
}

/** Angle of attack at which the disc makes no lift, rad. Slightly negative. */
export function zeroLiftAlpha(c: AeroCoeffs = AERO): number {
  return -c.CL0 / c.CLa;
}

/** 0 = normal (cavity into the wind), 1 = fully reversed (dome into the wind). */
export function reverseBlend(alpha: number, c: AeroCoeffs = AERO): number {
  return smoothstep01((zeroLiftAlpha(c) - alpha) / c.revWidth);
}

/** Lift coefficient, valid for any alpha in [-pi, pi]. */
export function liftCoeff(alpha: number, c: AeroCoeffs = AERO): number {
  const s = stallBlend(alpha, c);
  const attached = c.CL0 + c.CLa * alpha;
  let cl = attached;
  if (s > 0) cl = attached * (1 - s) + c.CLplate * Math.sin(2 * alpha) * s;
  const r = reverseBlend(alpha, c);
  return r > 0 ? cl * (1 - r * (1 - c.revLift)) : cl;
}

/** Drag coefficient, valid for any alpha in [-pi, pi]. Always > 0. */
export function dragCoeff(alpha: number, c: AeroCoeffs = AERO): number {
  const s = stallBlend(alpha, c);
  const d = alpha - c.alpha0;
  const attached = c.CD0 + c.CDa * d * d;
  let cd = attached;
  if (s > 0) {
    const sa = Math.sin(alpha);
    cd = attached * (1 - s) + (c.CD0 + c.CDplate * sa * sa) * s;
  }
  const r = reverseBlend(alpha, c);
  return r > 0 ? cd * (1 + r * (c.revDrag - 1)) : cd;
}

/**
 * Static pitching-moment coefficient (no rate damping).  The alpha term is
 * softly saturated so a tumbling disc cannot produce runaway moments.
 *
 * Note the sign change: CM0 < 0 and CMa > 0 means the moment is nose-DOWN at
 * the low alpha of a fast throw and nose-UP once the disc has slowed and is
 * mushing along at high alpha.  Precessed 90 degrees by the spin, that is
 * exactly the "high-speed turn, low-speed fade" of a real disc.
 */
export function pitchCoeff(alpha: number, c: AeroCoeffs = AERO): number {
  const sat = c.CMalphaSat;
  return c.CM0 + c.CMa * sat * Math.tanh(alpha / sat);
}
