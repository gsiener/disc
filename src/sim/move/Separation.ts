import { COMMITTED_STATES, type LocoPlayer } from './Types.ts';
import { clamp01 } from './Attributes.ts';

/**
 * ============================================================================
 * PERSONAL SPACE — the soft tier of body separation
 * ============================================================================
 *
 * There are two separation tiers in this model and they do different jobs.
 *
 *   HARD  (`Locomotion.resolveCollisions`, radius ~0.32 m)
 *         Physical contact. Impulses, momentum transfer, stumbles, fouls.
 *         It is a *floor*: it stops two bodies occupying the same volume, and
 *         because it is a floor, bodies pile up ON it. Measured over 300 s of
 *         match play, 1.5 % of all 91 pairwise samples sat in the 0.50-0.75 m
 *         bucket — three times the density of the 0.75-1.00 m bucket next door
 *         and higher than every bucket out to 2 m. That spike is what a viewer
 *         reads as "defenders and cutters fuse into one silhouette": with a
 *         shoulder half-width of ~0.28 m, two bodies 0.64 m apart have 8 cm of
 *         daylight between their outlines and none at all once the arms swing.
 *
 *   SOFT  (this file, radius ~0.63 m)
 *         Personal space. Athletes do not run shoulder-to-shoulder unless they
 *         are actually colliding; they leave a body's width. This tier pushes
 *         bodies apart *before* they touch, so the resting separation of two
 *         athletes who merely happen to be near each other is ~1.26 m centre to
 *         centre — about 0.7 m of daylight between silhouettes, which is the
 *         "tight coverage" look rather than the "one blob" look.
 *
 * ------------------------------------------------------------- design rules
 *
 * 1. IT MUST NOT FIGHT THE AI. Every spacing the AI actually asks for is wider
 *    than this radius: mark stand-off 2.15 m, stack spacing 4.2 m, defensive
 *    under-gap 0.9 m plus a 1.75 m open-side shade. So the soft tier only ever
 *    fires when bodies have converged into each other *by accident*, which is
 *    exactly the case we want fixed. On top of that, the correction is applied
 *    LATERALLY — see `pairAxis` — so it slides bodies past each other instead
 *    of braking them short of the spot they were sent to.
 *
 * 2. IT MUST NOT JITTER. Three separate guarantees:
 *      - positional only. No velocity is written, so no energy can enter the
 *        system and a resting contact cannot oscillate.
 *      - Jacobi, not Gauss-Seidel. Every pair is measured against the same
 *        snapshot and the corrections are summed, then applied once. A body
 *        squeezed between two others gets the resultant, not a ping-pong.
 *      - per-step rate limit and a half-step gain. A pair closes at most half
 *        its remaining overlap per step and never faster than SEP_RATE, so the
 *        approach is monotone and cannot overshoot into a reversal.
 *
 * 3. IT MUST BE DETERMINISTIC. No RNG anywhere — the degenerate cases (exactly
 *    coincident bodies, a perfectly head-on approach) break their ties on
 *    player id, which is stable for the life of the match. The capture rig
 *    depends on this.
 *
 * 4. IT MUST BE CHEAP. All-pairs over 14 bodies is 91 tests at 120 Hz. A
 *    spatial hash would cost more to maintain than the tests it saves.
 */

/* ------------------------------------------------------------------ tuning */

/**
 * Soft radius, metres. Two average bodies settle at twice this — 1.26 m centre
 * to centre, ~0.70 m of daylight between shoulder lines.
 */
export const PERSONAL_RADIUS = 0.63;

/**
 * Ceiling on how fast a body is slid sideways to make room, m/s. Athletes
 * adjust their line at roughly a metre a second; faster than that and the
 * correction stops reading as a step and starts reading as a shove.
 */
export const SEP_RATE = 1.60;

/** Overlap under this is simply ignored, so a settled pair stops moving. */
export const SEP_DEADBAND = 0.02;

/** Beyond this vertical gap two bodies miss each other entirely. */
export const SEP_Y_SPAN = 1.0;

/**
 * If the separation normal is within this much of the pair's commanded
 * approach axis, there is no meaningful lateral component to keep and we pick
 * a side to pass on instead. 0.25 is ~14 degrees either side of head-on.
 */
const LATERAL_MIN = 0.25;

/**
 * Personal space is a comfort behaviour, and a disc in play is the one thing
 * that overrides comfort — athletes crowd a contested disc shoulder to
 * shoulder, and the game's catch geometry depends on it: `Game.CATCH_REACH` is
 * 0.82 m, so a receiver and the defender bidding over them cannot BOTH be
 * inside catch range if personal space is holding them 1.26 m apart. Left in,
 * this quietly costs completions, strands dead discs nobody can collect, and
 * turns a contested catch into a polite queue.
 *
 * So the soft radius fades out near a live disc: full personal space beyond
 * DISC_FREE_R, none at all inside DISC_GRAB_R, smoothly between. The hard
 * contact radius is untouched — bodies still cannot interpenetrate, they are
 * just allowed to get as close as a real contest is.
 */
export const DISC_GRAB_R = 1.15;
export const DISC_FREE_R = 3.20;

/** Where the disc is, and whether it is loose. Filled by `DiscProbe`. */
export interface DiscFocus { x: number; z: number; live: boolean }

/**
 * The disc position, duck-typed off the system registry every step exactly the
 * way `GroundProbe` duck-types the field. The disc is authored in another file
 * by another agent, so this never imports it and degrades to "no disc" when it
 * is absent — which simply means personal space applies everywhere, the
 * behaviour of a headless unit test.
 *
 * Only a LOOSE disc relaxes anything. While the disc is in a hand the crowding
 * we want is the marker's, and that is 2.15 m out and governed by the AI.
 */
export class DiscProbe {
  private runtime: { mode?: string; state?: { pos?: { x: number; z: number } } } | null = null;

  bind(sys: Record<string, unknown> | undefined | null): void {
    this.runtime = null;
    if (!sys) return;
    const game = sys['game'] as { discRuntime?: unknown } | undefined;
    const cand = (game?.discRuntime ?? sys['disc']) as
      { mode?: string; state?: { pos?: { x: number; z: number } } } | undefined;
    if (cand && cand.state && cand.state.pos
      && typeof cand.state.pos.x === 'number' && typeof cand.state.pos.z === 'number') {
      this.runtime = cand;
    }
  }

  read(out: DiscFocus): DiscFocus {
    const r = this.runtime;
    const pos = r?.state?.pos;
    const live = !!r && r.mode !== 'held' && !!pos
      && Number.isFinite(pos.x) && Number.isFinite(pos.z);
    out.live = live;
    out.x = live ? pos!.x : 0;
    out.z = live ? pos!.z : 0;
    return out;
  }
}

/* -------------------------------------------------------------- compliance */

/**
 * How readily this body yields ground, in inverse-mass units. Zero means "do
 * not touch": a body in the air is a projectile and a body that is laid out,
 * landing, falling or getting up is committed to a physical event that the
 * soft tier has no business editing. In both cases the *other* body takes the
 * whole correction, which is what you want — the upright athlete is the one
 * who can step around.
 */
export function compliance(p: LocoPlayer): number {
  if (p.air.airborne) return 0;
  if (COMMITTED_STATES.has(p.state)) return 0;
  if (p.prone) return 0;
  // A thrower on his pivot holds his ground; the marker steps around him.
  if (p.anchored) return 0;
  // Same weighting the hard tier uses: heavy, braced bodies move less.
  const braced = p.attr.mass * (1 + 0.35 * clamp01(p.attr.strength / 100));
  return 1 / Math.max(1, braced);
}

/* -------------------------------------------------------------- pair axis */

/**
 * Direction body `b` should be nudged (and `a` the opposite way).
 *
 * Starting point is the separation normal `n`. From it we remove the component
 * along the pair's *commanded relative approach* — the direction in which the
 * two players have been told to close on each other. What is left is pure
 * lateral: it opens a gap without slowing either athlete's progress toward the
 * spot the AI sent them to. A marker still reaches the mark; a cutter still
 * runs their lane; they just do it a shoulder's width off each other.
 *
 * If nothing is left (a dead-on collision course, or one body directly behind
 * the other in the same lane) there is no lateral component to preserve, so we
 * pick one: the perpendicular of the approach axis, with the side chosen by
 * player id. Id order never changes during a match, so the pair always passes
 * on the same side and can never flicker between them.
 *
 * Writes into `out` and returns it.
 */
function pairAxis(
  a: LocoPlayer, b: LocoPlayer, nx: number, nz: number, out: { x: number; z: number },
): { x: number; z: number } {
  let cx = a.cmd.x - b.cmd.x;
  let cz = a.cmd.z - b.cmd.z;
  const cl = Math.hypot(cx, cz);
  if (cl < 1e-3) { out.x = nx; out.z = nz; return out; }
  cx /= cl; cz /= cl;

  const along = nx * cx + nz * cz;
  const px = nx - along * cx;
  const pz = nz - along * cz;
  const pl = Math.hypot(px, pz);
  if (pl >= LATERAL_MIN) { out.x = px / pl; out.z = pz / pl; return out; }

  // Head-on, or one directly astern of the other: choose a side and hold it.
  const s = a.id < b.id ? 1 : -1;
  out.x = cz * s;
  out.z = -cx * s;
  return out;
}

/* ------------------------------------------------------------------ solve */

const AXIS = { x: 0, z: 0 };

/**
 * Accumulate one Jacobi pass of personal-space corrections into `outX`/`outZ`,
 * which the caller must have zeroed and sized to `list.length`. Returns the
 * number of engaged pairs (0 means nothing moved, so the caller can skip the
 * apply pass entirely — which is the common case once bodies are spread).
 *
 * Nothing here reads or writes velocity, and nothing here reads the clock.
 */
export function accumulateSeparation(
  list: readonly LocoPlayer[], dt: number, outX: Float64Array, outZ: Float64Array,
  disc?: DiscFocus | null, softR?: Float64Array,
): number {
  const n = list.length;
  let engaged = 0;
  const step = SEP_RATE * dt;

  // Per-body effective soft radius, faded out near a loose disc. O(n), done
  // once, so the pair loop stays a plain distance test.
  const soften = softR && softR.length >= n ? softR : new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (!disc || !disc.live) { soften[i] = p.personal; continue; }
    const d = Math.hypot(p.pos.x - disc.x, p.pos.z - disc.z);
    const t = clamp01((d - DISC_GRAB_R) / (DISC_FREE_R - DISC_GRAB_R));
    soften[i] = p.radius + (p.personal - p.radius) * (t * t * (3 - 2 * t));
  }

  for (let i = 0; i < n; i++) {
    const a = list[i];
    const wa = compliance(a);
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      const wb = compliance(b);
      const wsum = wa + wb;
      if (wsum <= 0) continue;
      if (Math.abs(a.pos.y - b.pos.y) > SEP_Y_SPAN) continue;

      let sx = b.pos.x - a.pos.x;
      let sz = b.pos.z - a.pos.z;
      const soft = soften[i] + soften[j];
      let d2 = sx * sx + sz * sz;
      if (d2 >= soft * soft) continue;

      let dist = Math.sqrt(d2);
      if (dist < 1e-4) {
        // Exactly coincident. Break the tie on ids so the pair always parts
        // along the same axis — a seeded angle here would be deterministic
        // too, but not *stable*, and an unstable axis is a shudder.
        const k = ((a.id * 31 + b.id) % 16) * (Math.PI / 8);
        sx = Math.cos(k); sz = Math.sin(k);
        dist = 1e-4;
        d2 = dist * dist;
      }
      const nx = sx / dist, nz = sz / dist;

      const pen = soft - dist - SEP_DEADBAND;
      if (pen <= 0) continue;

      // Engagement ramps smoothly from nothing at the soft radius to full at
      // hard contact. A smoothstep rather than a linear ramp because the
      // derivative at both ends is zero, so a body drifting across the
      // boundary is never handed a step change in correction.
      const hard = a.radius + b.radius;
      const span = Math.max(1e-4, soft - hard);
      const tw = clamp01((soft - dist) / span);
      const w = tw * tw * (3 - 2 * tw);

      // Half-step gain: the pair never closes more than half the remaining
      // overlap in one tick, so the approach is monotone and cannot ring.
      const amount = Math.min(step * w, pen * 0.5);
      if (amount <= 1e-7) continue;

      const L = pairAxis(a, b, nx, nz, AXIS);
      const fa = wa / wsum, fb = wb / wsum;
      outX[i] -= L.x * amount * fa;
      outZ[i] -= L.z * amount * fa;
      outX[j] += L.x * amount * fb;
      outZ[j] += L.z * amount * fb;
      engaged++;
    }
  }

  // Per-body ceiling on the resultant. A body wedged between three others can
  // otherwise be handed the sum of three full corrections and squirt out.
  if (engaged > 0) {
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(outX[i], outZ[i]);
      if (m > step) { const k = step / m; outX[i] *= k; outZ[i] *= k; }
    }
  }
  return engaged;
}
