import * as THREE from 'three';
import {
  Basis, DEG, SpringVec3, approach, approachAngle, clamp, dollyVelocity,
  fovForHeight, fovForWidth, spring1,
  type CamPlayer, type PathPoint, type Spring1, type WorldView,
} from './View.ts';

/**
 * THE TELE BROADCAST RIG — the only camera during live play.
 *
 * One virtual camera on a dolly line 23.5 m outside the −X sideline. It
 * translates in Z only; it pans, tilts and zooms; it never cuts. Every number
 * below is from the design brief's table and is asserted numerically in
 * `tools/test-camera.ts`.
 *
 * The one idea worth restating, because everything else follows from it: WHEN
 * THE DISC IS IN THE AIR THIS CAMERA DOES NOT TRACK IT. A max backhand leaves
 * the hand at 27 m/s; at 45 m range that is a 35°/s angular rate, and the pan
 * cap is 38°/s — so a camera that tried to follow the disc would spend the
 * whole flight at its rate limit, arrive late at the catch, and read as a
 * panicked operator. Instead the rig aims at the point 60% of the way along the
 * REMAINING flight by time, re-solved at 10 Hz against the same integrator the
 * disc actually flies. The disc then travels *through* a frame that is already
 * looking where it is going, and the catch happens near the middle of the shot.
 * It leads and waits; it never chases.
 */

export const TELE = {
  /* rig geometry */
  POS_X: -42,
  POS_Y: 15,

  /* dolly */
  DOLLY_GAIN: 0.80,
  DOLLY_GAIN_HUCK: 0.90,
  DOLLY_LIMIT: 36,
  DOLLY_SPEED: 12,
  DOLLY_ACCEL: 18,

  /* lens */
  FOV_BASE: 22,
  FOV_REDZONE: 20,
  FOV_MIN: 17,
  FOV_MAX: 30,
  FOV_RATE: 7,
  FOV_OMEGA: 1.6,
  FOV_HUCK_BONUS: 5,

  /* head */
  AIM_OMEGA: 3.2,
  PAN_RATE: 38,
  TILT_RATE: 18,
  AIM_Y: 1.45,

  /* focus point */
  DISC_W: 0.65,
  CENTROID_W: 0.35,
  CENTROID_R: 25,
  LEAD: 6,

  /* framing solve */
  FIT_WIDTH: 0.72,
  FIT_HEIGHT: 0.78,
  /** The disc gets a looser guard than the play does — see `solveFov`. */
  DISC_GUARD_W: 0.78,
  DISC_GUARD_H: 0.82,
  SPREAD_Z: 30,

  /* framing guarantee — see `correctFraming` */
  /**
   * Fraction of the half-frame the disc, thrower and marker are held inside.
   * The gap to the frame edge is not padding: the head chases the aim through
   * the ω = 3.2 spring and sits three or four degrees behind it whenever the
   * play is moving, which at the 30° stop is 0.12 of NDC. This margin is what
   * that lag is spent out of.
   */
  GUARD_W: 0.64,
  GUARD_H: 0.68,
  /**
   * ...and the box the operator falls back to when the comfortable one cannot
   * hold five offenders. Spending the margin is bad; a frame with two thirds of
   * the offence outside it is worse, and this is the order a real operator
   * makes that trade in.
   */
  RELAX_W: 0.74,
  RELAX_H: 0.78,
  /** ...and the fraction the offence is COUNTED against, near the frame edge. */
  COUNT_W: 0.78,
  COUNT_H: 0.82,
  /**
   * ...and the box a counted body is COMFORTABLE in. A framing that holds five
   * bodies with one of them a pixel inside the edge is a framing that will hold
   * four in a fifth of a second, and the head cannot pan back at 38°/s from a
   * standing start in less. Preferring the roomier of two otherwise identical
   * framings is what turns the guarantee from a thing defended at the last
   * moment into a thing that is never in danger.
   */
  SNUG_W: 0.68,
  SNUG_H: 0.72,
  /** Offensive players the shot must hold while the disc is held. */
  GUARD_MIN: 5,
  /** A defender this close to the thrower is framed whether or not he is the mark. */
  MARK_R: 16,
  /** How far the operator may skew off the focus point to keep them, degrees. */
  SKEW_PAN: 20,
  SKEW_TILT: 10,

  /* flight */
  FLIGHT_FRAC: 0.60,
  FLIGHT_FRAC_HUCK: 0.65,
  PREDICT_DT: 0.10,
  HUCK_CARRY: 28,
  HUCK_TIME: 2.0,
  HUCK_RAMP: 0.25,

  /* red zone */
  REDZONE_DIST: 18,
  REDZONE_OVERSHOOT: 6,
  REDZONE_RAMP: 0.35,

  /** Dead air after a turnover: the tele holds its framing, stone still. */
  TURNOVER_HOLD: 0.8,
} as const;

const _tan = { h: 0, v: 0 };
const _look = new THREE.Vector3();
/** Scratch look-point for the framing guarantee's head basis. */
const _skew = new THREE.Vector3();
/** Scratch: the head's target direction, before and after the guarantee. */
const _dir = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export interface TeleTelemetry {
  /** Degrees per second actually applied this frame. */
  panRate: number;
  tiltRate: number;
  zoomRate: number;
  /** Metres per second along the dolly line. */
  dollySpeed: number;
  /** 0..1 — how far the aim point sits from the disc toward the landing spot. */
  leadFrac: number;
  huck: number;
  redZone: number;
  frozen: boolean;
  /** Degrees of framing skew applied off the focus point this frame. */
  skewPan: number;
  skewTilt: number;
}

export class TeleRig {
  readonly pos = new THREE.Vector3(TELE.POS_X, TELE.POS_Y, 0);
  /** Where the head is actually pointed (radians). */
  yaw = Math.PI / 2;
  pitch = -0.3;
  fov: number = TELE.FOV_BASE;

  /** Commanded aim point — the 60% flight lead, or the focus solve. */
  readonly aimTarget = new THREE.Vector3(0, TELE.AIM_Y, 0);
  /** Spring-smoothed aim point; this is what the head is chasing. */
  private readonly aim = new SpringVec3();
  private readonly fovSpring: Spring1 = { x: TELE.FOV_BASE, v: 0 };

  private dollyVel = 0;
  private dollyTarget = 0;
  private fovTarget: number = TELE.FOV_BASE;

  private huckRamp = 0;
  private redRamp = 0;
  private wasFlight = false;
  private sincePredict = 1e3;
  private path: PathPoint[] = [];
  private isHuck = false;
  private isPull = false;
  /** False until the rig has been framed once — see the cold start in `update`. */
  private primed = false;

  private readonly basis = new Basis();
  private readonly guardBasis = new Basis();
  private readonly focus = new THREE.Vector3();
  private readonly landing = new THREE.Vector3();
  /** Scratch for the framing guarantee: offence tangents, and window centres. */
  private readonly gh: number[] = [];
  private readonly gv: number[] = [];
  private readonly candH: number[] = [];
  private readonly candV: number[] = [];
  /** Scratch for the lens's ≥5 guarantee: per-offender FOV demand, sorted. */
  private readonly needs: number[] = [];
  private skewPan = 0;
  private skewTilt = 0;

  readonly telemetry: TeleTelemetry = {
    panRate: 0, tiltRate: 0, zoomRate: 0, dollySpeed: 0,
    leadFrac: 1, huck: 0, redZone: 0, frozen: false,
    skewPan: 0, skewTilt: 0,
  };

  /* ------------------------------------------------------------------ step */

  update(dt: number, w: WorldView, aspect: number): void {
    const t = this.telemetry;
    const step = Math.max(1e-4, Math.min(dt, 0.1));

    /**
     * COLD START. The rig has no framing before it has seen a world, and the
     * head's constructed yaw points down the −X sideline — away from the field,
     * because that is what "no information" looks like. Slewing out of that
     * under the 38°/s pan cap takes five seconds of pointing at the crowd, and
     * it happens on any session where the tele is the first camera on air (a
     * live match resumed mid-possession, which is exactly what the game does).
     * The first frame is not a move, it is an arrival: snap.
     */
    if (!this.primed) { this.snap(w, aspect); return; }

    this.repredict(step, w);
    const flight = (w.discFlight || w.phase === 'PULL_IN_FLIGHT') && this.path.length > 1;

    // Ramps. Both are one-way smooth so a huck or a red-zone entry is a move,
    // not a step — the brief's 0.25 s huck ramp is exactly this.
    this.huckRamp = approach(this.huckRamp, flight && this.isHuck ? 1 : 0, step / TELE.HUCK_RAMP);
    this.redRamp = approach(this.redRamp, this.inRedZone(w) ? 1 : 0, step / TELE.REDZONE_RAMP);

    this.solveAim(w, flight);

    /**
     * The turnover beat. On a drop or a block the operator does not push in and
     * does not re-frame: the disc lying in the grass with the camera dead still
     * IS the feedback. 0.8 s of nothing, then the rig resumes (and the cut
     * machine may take the low endzone).
     */
    const frozen = w.phase === 'TURNOVER_DEAD' && w.phaseTimer < TELE.TURNOVER_HOLD;
    t.frozen = frozen;
    if (frozen) {
      // Park the integrators, do not merely stop reading them. Holding the
      // pre-freeze dolly velocity across the beat and then resuming with it
      // puts the whole of it into the first unfrozen frame — a 6 m/s step is
      // ~360 m/s², twenty times the acceleration cap, and it reads as the rig
      // being yanked the instant the disc is picked up. Coming back from rest
      // costs a third of a second of ramp and looks like an operator.
      //
      // The dolly BRAKES rather than stopping dead, at the same 18 m/s² it
      // accelerates under. A camera on rails cannot stop in a frame, and a hard
      // stop is the only thing in this rig that would read as a glitch rather
      // than as a decision.
      this.dollyVel = dollyVelocity(
        this.pos.z, this.pos.z, this.dollyVel, TELE.DOLLY_SPEED, TELE.DOLLY_ACCEL, step);
      this.pos.z = clamp(this.pos.z + this.dollyVel * step, -TELE.DOLLY_LIMIT, TELE.DOLLY_LIMIT);
      this.aim.set(this.aim.value.x, this.aim.value.y, this.aim.value.z);
      this.fovSpring.v = 0;
      t.panRate = 0; t.tiltRate = 0; t.zoomRate = 0; t.dollySpeed = Math.abs(this.dollyVel);
      t.huck = this.huckRamp; t.redZone = this.redRamp;
      return;
    }

    /* ---- dolly ---------------------------------------------------------- */
    const gain = TELE.DOLLY_GAIN + (TELE.DOLLY_GAIN_HUCK - TELE.DOLLY_GAIN) * this.huckRamp;
    const overshoot = TELE.REDZONE_OVERSHOOT * this.redRamp * w.attackDir;
    this.dollyTarget = clamp(gain * this.focus.z + overshoot, -TELE.DOLLY_LIMIT, TELE.DOLLY_LIMIT);
    this.dollyVel = dollyVelocity(
      this.pos.z, this.dollyTarget, this.dollyVel, TELE.DOLLY_SPEED, TELE.DOLLY_ACCEL, step);
    // Clamping the position without killing the velocity leaves the rig pressed
    // against the end of the track carrying speed it cannot spend; the frame it
    // finally turns around, that stored velocity comes back as a step. Zero it
    // on contact, the way a real dolly stops when it reaches the end.
    const rawZ = this.pos.z + this.dollyVel * step;
    this.pos.z = clamp(rawZ, -TELE.DOLLY_LIMIT, TELE.DOLLY_LIMIT);
    if (rawZ !== this.pos.z) this.dollyVel = 0;
    this.pos.x = TELE.POS_X;
    this.pos.y = TELE.POS_Y;
    t.dollySpeed = Math.abs(this.dollyVel);

    /* ---- aim ------------------------------------------------------------ */
    const aim = this.aim.step(this.aimTarget, TELE.AIM_OMEGA, step);

    /* ---- head ----------------------------------------------------------- */
    _dir.set(aim.x - this.pos.x, aim.y - this.pos.y, aim.z - this.pos.z);
    if (!flight) this.correctFraming(w, aspect, _dir);
    const dx = _dir.x, dy = _dir.y, dz = _dir.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const wantPitch = Math.asin(clamp(dy / len, -1, 1));
    const wantYaw = Math.atan2(-dx / len, -dz / len);
    const nextYaw = approachAngle(this.yaw, wantYaw, TELE.PAN_RATE * DEG * step);
    const nextPitch = approach(this.pitch, wantPitch, TELE.TILT_RATE * DEG * step);
    t.panRate = Math.abs(shortAngle(nextYaw - this.yaw)) / DEG / step;
    t.tiltRate = Math.abs(nextPitch - this.pitch) / DEG / step;
    this.yaw = nextYaw;
    this.pitch = nextPitch;

    /**
     * ---- lens ----
     *
     * Solved against where the head IS, not where the aim point is. The pan cap
     * is 38°/s and a receiver can cross the frame faster than that, so during a
     * hard pan the two differ by a couple of degrees — and a field of view fitted
     * to the aim rather than to the actual axis quietly lets the marker fall off
     * the edge of a frame the solver believed was fine.
     */
    this.setBasisFromHead();
    this.fovTarget = this.solveFov(w, flight, aspect);
    const springFov = spring1(this.fovSpring, this.fovTarget, TELE.FOV_OMEGA, step);
    const nextFov = clamp(
      approach(this.fov, springFov, TELE.FOV_RATE * step), TELE.FOV_MIN, TELE.FOV_MAX);
    t.zoomRate = Math.abs(nextFov - this.fov) / step;
    this.fov = nextFov;

    t.huck = this.huckRamp;
    t.redZone = this.redRamp;
  }

  /**
   * Hard-cut arrival: the rig is already framed when the cut lands, because a
   * cut to a camera that then slews for a third of a second is two shots.
   * Called by the shot machine on every cut back to the tele.
   */
  snap(w: WorldView, aspect: number): void {
    this.primed = true;
    this.sincePredict = 1e3;
    this.repredict(0, w);
    const flight = (w.discFlight || w.phase === 'PULL_IN_FLIGHT') && this.path.length > 1;
    this.huckRamp = flight && this.isHuck ? 1 : 0;
    this.redRamp = this.inRedZone(w) ? 1 : 0;
    this.solveAim(w, flight);

    const gain = TELE.DOLLY_GAIN + (TELE.DOLLY_GAIN_HUCK - TELE.DOLLY_GAIN) * this.huckRamp;
    const overshoot = TELE.REDZONE_OVERSHOOT * this.redRamp * w.attackDir;
    this.pos.set(TELE.POS_X, TELE.POS_Y,
      clamp(gain * this.focus.z + overshoot, -TELE.DOLLY_LIMIT, TELE.DOLLY_LIMIT));
    this.dollyVel = 0;

    this.aim.set(this.aimTarget.x, this.aimTarget.y, this.aimTarget.z);
    _dir.set(
      this.aim.value.x - this.pos.x,
      this.aim.value.y - this.pos.y,
      this.aim.value.z - this.pos.z);
    let len = _dir.length() || 1;
    this.pitch = Math.asin(clamp(_dir.y / len, -1, 1));
    this.yaw = Math.atan2(-_dir.x / len, -_dir.z / len);
    // One pass of the framing guarantee about the head we just adopted, so the
    // cut lands on a frame that already holds the play rather than one that
    // slews into holding it over the next tenth of a second.
    if (!flight) {
      this.correctFraming(w, aspect, _dir);
      len = _dir.length() || 1;
      this.pitch = Math.asin(clamp(_dir.y / len, -1, 1));
      this.yaw = Math.atan2(-_dir.x / len, -_dir.z / len);
    }

    this.setBasisFromHead();
    this.fov = this.solveFov(w, flight, aspect);
    this.fovSpring.x = this.fov; this.fovSpring.v = 0;

    const t = this.telemetry;
    t.panRate = 0; t.tiltRate = 0; t.zoomRate = 0; t.dollySpeed = 0;
  }

  apply(cam: THREE.PerspectiveCamera): void {
    cam.position.copy(this.pos);
    _e.set(this.pitch, this.yaw, 0, 'YXZ');
    cam.quaternion.setFromEuler(_e);
    if (Math.abs(cam.fov - this.fov) > 1e-4) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  /* ------------------------------------------------------------ prediction */

  private repredict(dt: number, w: WorldView): void {
    this.sincePredict += dt;
    const flying = w.discFlight || w.phase === 'PULL_IN_FLIGHT';
    if (!flying) {
      this.wasFlight = false;
      if (this.path.length) this.path = [];
      return;
    }
    const fresh = !this.wasFlight;
    this.wasFlight = true;
    if (!fresh && this.sincePredict < TELE.PREDICT_DT) return;

    let path: readonly PathPoint[] = [];
    try { path = w.predict(); } catch { path = []; }
    if (path.length < 2) return;
    this.path = path.slice();
    this.sincePredict = 0;

    const end = this.path[this.path.length - 1];
    this.landing.set(end.x, end.y, end.z);
    this.isPull = w.phase === 'PULL_IN_FLIGHT';
    if (fresh) {
      // The huck test, taken once per flight off the release prediction:
      // predicted carry >= 28 m, or a flight >= 2 s in the air.
      const carry = Math.hypot(end.x - w.disc.x, end.z - w.disc.z);
      this.isHuck = carry >= TELE.HUCK_CARRY || end.t >= TELE.HUCK_TIME;
    }
  }

  /* -------------------------------------------------------------- the aim */

  /**
   * The aim point: the flight lead, or the brief's composition. It is NOT where
   * the frame ends up — `correctFraming` may skew the head off it to keep the
   * mark and the shape on screen — but it is the shot the rig is trying to make.
   */
  private solveAim(w: WorldView, flight: boolean): void {
    if (flight) this.aimFlight(w); else this.aimHeld(w);
  }

  /**
   * THE FRAMING GUARANTEE.
   *
   * The focus point is the composition the brief asks for — thrower at ~38% of
   * frame width, six metres of lead room open downfield — and for most of a
   * match it is also a frame that holds everything the viewer needs. It is not
   * always. When the disc is jammed against the near sideline the camera is only
   * 25 m away while the far side of the play is 55 m away, so the same seven
   * bodies subtend better than 50°; the lens is already clamped at its 30° stop
   * and the shot simply cannot be widened any further.
   *
   * At that point a real operator stops zooming and re-frames — he gives up lead
   * room, because a frame with the marker outside it is not a shot of a game.
   * This does exactly that, and only that. The disc, the thrower and the mark
   * are hard constraints; among the frame placements that hold all of them, it
   * picks the one that holds the most offensive bodies, and breaks ties toward
   * the brief's own composition — so on the overwhelming majority of frames the
   * answer is that composition untouched, and the correction only ever spends as
   * much lead room as the geometry actually takes.
   *
   * WHERE IT ACTS, which took a rewrite to get right. The obvious place is the
   * aim point, and it is the wrong one: the aim point is low-passed by the ω =
   * 3.2 spring on its way to the head, so a correction posted there arrives a
   * third of a second late and, worse, the solver reads a frame centre the head
   * has not reached and concludes the shot is fine. Measured on a real match
   * that gap runs to eight degrees — a third of the half-frame — and it is
   * exactly the amount by which the mark fell off the edge.
   *
   * So the correction is applied to the head's TARGET DIRECTION, after the
   * spring, and it is measured about where the head actually points. The
   * composition still flows through the spring and is still smooth; the
   * guarantee rides on top of it and is spent through the 38°/s pan cap, which
   * is the whip a real operator does when the mark leaves his frame. Every
   * tangent below is therefore literally an NDC coordinate of the frame being
   * drawn this instant, and the solve re-runs against its own output each frame,
   * which is a proportional controller on framing error and settles in two or
   * three frames.
   */
  private correctFraming(w: WorldView, aspect: number, dir: THREE.Vector3): void {
    this.skewPan = 0;
    this.skewTilt = 0;
    this.telemetry.skewPan = 0;
    this.telemetry.skewTilt = 0;
    if (w.phase !== 'LIVE_POSSESSION' && w.phase !== 'CHECK') return;
    if (w.throwerId < 0) return;
    if (!(dir.length() > 1)) return;

    /**
     * TWO boxes, in tangent units, at the lens the rig is actually on (`this.fov`
     * is last frame's — it moves at most 7°/s, and using it rather than a value
     * solved from this correction is what keeps the two loops decoupled).
     *
     * The hard box is where the disc, the thrower and the mark are held: inside
     * the frame with a margin, because losing one of those is a broken shot and
     * the margin is what absorbs a frame of play. The count box is nearly the
     * frame itself, because it decides HOW MANY offensive bodies a candidate
     * framing holds — and a count taken against an artificially small frame
     * answers a question nobody asked and picks the wrong shot.
     */
    const half = Math.tan(this.fov * 0.5 * DEG);
    const hardH = TELE.GUARD_W * half * aspect;
    const hardV = TELE.GUARD_H * half;
    const relaxH = TELE.RELAX_W * half * aspect;
    const relaxV = TELE.RELAX_H * half;
    const countH = TELE.COUNT_W * half * aspect;
    const countV = TELE.COUNT_H * half;
    const snugH = TELE.SNUG_W * half * aspect;
    const snugV = TELE.SNUG_H * half;
    if (!(hardH > 1e-4) || !(hardV > 1e-4)) return;

    // The head's basis: where the frame being drawn this instant is pointed.
    const cp = Math.cos(this.pitch);
    _skew.set(
      this.pos.x - Math.sin(this.yaw) * cp,
      this.pos.y + Math.sin(this.pitch),
      this.pos.z - Math.cos(this.yaw) * cp);
    const b = this.guardBasis.set(this.pos, _skew);

    // Where the brief's composition wants the frame centred, as a tangent off
    // that axis. Every tie in the solve below is broken toward this.
    const fwd = dir.dot(b.f);
    if (!(fwd > 1)) return;
    const prefH = dir.dot(b.r) / fwd;
    const prefV = dir.dot(b.u) / fwd;

    let hLo = Infinity, hHi = -Infinity, vLo = Infinity, vHi = -Infinity;
    const eat = (x: number, y: number, z: number): boolean => {
      if (!b.tangents(x, y, z, _tan)) return false;
      if (_tan.h < hLo) hLo = _tan.h;
      if (_tan.h > hHi) hHi = _tan.h;
      if (_tan.v < vLo) vLo = _tan.v;
      if (_tan.v > vHi) vHi = _tan.v;
      return true;
    };

    // The bodies the shot may never drop, whatever it costs.
    eat(w.disc.x, Math.max(w.disc.y, 0.5), w.disc.z);
    let thrower: CamPlayer | null = null;
    for (const p of w.players) {
      if (p.id === w.throwerId) thrower = p;
      if (p.id === w.throwerId || p.id === w.markerId) eat(p.x, 1.15, p.z);
    }

    /**
     * ...and whoever is nearest the thrower on the other team, designated or
     * not. The mark is a job rather than an identity — `Game.markerId()` is the
     * defensive AI's assignment and it hands over the instant another body takes
     * the job, sometimes to a player still fifteen metres away and sprinting in.
     * A frame that holds only the current holder of the job has to slew every
     * time it changes hands, and at the 38°/s pan cap that slew is a tenth of a
     * second with the new mark outside the frame. Framing the nearest body as
     * well makes the handover invisible, which is what it should be.
     */
    if (thrower) {
      let near: CamPlayer | null = null;
      let bd = TELE.MARK_R * TELE.MARK_R;
      for (const p of w.players) {
        if (p.team === w.offence) continue;
        const d = (p.x - thrower.x) * (p.x - thrower.x) + (p.z - thrower.z) * (p.z - thrower.z);
        if (d < bd) { bd = d; near = p; }
      }
      if (near && near.id !== w.markerId) eat(near.x, 1.15, near.z);
    }
    if (hLo > hHi) return;

    // ...and the offence, whom the frame holds as many of as it can.
    const gh = this.gh, gv = this.gv;
    gh.length = 0; gv.length = 0;
    for (const p of w.players) {
      if (p.team !== w.offence) continue;
      if (p.id === w.throwerId) continue;          // already a hard constraint
      if (!b.tangents(p.x, 1.15, p.z, _tan)) continue;
      gh.push(_tan.h); gv.push(_tan.v);
    }

    /**
     * The window solve, over both axes AT ONCE.
     *
     * It is tempting to settle height and then width, and it is wrong: a body
     * dropped by the height pass is invisible to the width pass, so the greedy
     * answer can be a whole body short of the joint optimum on exactly the
     * frames where the guarantee is under strain. "Cover the most points with a
     * fixed-size box" attains its optimum with a point on an edge of the box, so
     * six offenders give at most thirteen candidate centres per axis — a hundred
     * and sixty-nine boxes to score, a thousand comparisons, once a frame.
     */
    let ch = prefH, cv = prefV, bestN = -1, bestS = -1;
    for (let pass = 0; pass < 2; pass++) {
      const rh = pass === 0 ? hardH : relaxH;
      const rv = pass === 0 ? hardV : relaxV;
      const hCand = windowCentres(this.candH, prefH, gh, countH, hLo, hHi, rh);
      const vCand = windowCentres(this.candV, prefV, gv, countV, vLo, vHi, rv);
      let n0 = -1, s0 = -1, x0 = hCand[0], y0 = vCand[0], d0 = Infinity;
      for (const x of hCand) {
        for (const y of vCand) {
          // Lexicographic: bodies held, then bodies held with room to spare,
          // then the brief's composition — the last measured in units of each
          // axis's own skew cap so a degree of pan trades against a degree of
          // tilt fairly.
          let n = 0, snug = 0;
          for (let i = 0; i < gh.length; i++) {
            const dh = Math.abs(gh[i] - x), dv = Math.abs(gv[i] - y);
            if (dh > countH || dv > countV) continue;
            n++;
            if (dh <= snugH && dv <= snugV) snug++;
          }
          const s = n * 16 + snug;
          const d = Math.abs(x - prefH) / SKEW_H_TAN + Math.abs(y - prefV) / SKEW_V_TAN;
          if (s > s0 || (s === s0 && d < d0 - 1e-9)) { n0 = n; s0 = s; d0 = d; x0 = x; y0 = y; }
        }
      }
      if (s0 > bestS) { bestN = n0; bestS = s0; ch = x0; cv = y0; }
      // The comfortable box did the job. Do not spend the margin to gain a body
      // the brief did not ask for — five is the number, and holding six at the
      // cost of the marker's headroom is a worse shot, not a better one.
      if (bestN + 1 >= TELE.GUARD_MIN) break;
    }

    // The skew is what is left after the brief's own composition: zero on the
    // overwhelming majority of frames, and never more than the caps.
    const sh = clamp(ch - prefH, -SKEW_H_TAN, SKEW_H_TAN);
    const sv = clamp(cv - prefV, -SKEW_V_TAN, SKEW_V_TAN);
    if (sh === 0 && sv === 0) return;
    dir.addScaledVector(b.r, sh * fwd);
    dir.addScaledVector(b.u, sv * fwd);
    this.skewPan = Math.atan(sh) / DEG;
    this.skewTilt = Math.atan(sv) / DEG;
    this.telemetry.skewPan = this.skewPan;
    this.telemetry.skewTilt = this.skewTilt;
  }

  /**
   * Disc held or dead. F = 0.65·disc + 0.35·offCentroid, then six metres of
   * lead room downfield. That puts the thrower around 38% of the way across the
   * frame with the space he is throwing into occupying the other 62% — the
   * rule-of-thirds lead every football broadcast uses, and the reason the stack
   * and the room behind it are both legible from a single camera.
   */
  private aimHeld(w: WorldView): void {
    const d = w.disc;
    let cx = 0, cz = 0, n = 0;
    const r2 = TELE.CENTROID_R * TELE.CENTROID_R;
    for (const p of w.players) {
      if (p.team !== w.offence) continue;
      const ddx = p.x - d.x, ddz = p.z - d.z;
      if (ddx * ddx + ddz * ddz > r2) continue;
      cx += p.x; cz += p.z; n++;
    }
    if (n === 0) { cx = d.x; cz = d.z; } else { cx /= n; cz /= n; }

    this.focus.set(
      TELE.DISC_W * d.x + TELE.CENTROID_W * cx,
      TELE.AIM_Y,
      TELE.DISC_W * d.z + TELE.CENTROID_W * cz + w.attackDir * TELE.LEAD,
    );
    this.aimTarget.copy(this.focus);
    this.landing.copy(this.focus);
    this.telemetry.leadFrac = 1;
  }

  /**
   * Disc in flight. The aim point is the path sample 60% of the way along the
   * REMAINING flight by time (65% on a huck), advanced if necessary until it is
   * also at least 60% of the way along the chord from the disc to the landing
   * spot — which is what makes the brief's ">= 55% of the way from disc to
   * predicted landing" a property of the code rather than a hope.
   *
   * A pull is a special case: the tele is aimed at the landing point outright,
   * because the handoff from the aerial happens at 60% of the pull's flight and
   * the shot it cuts into has to already be the catch.
   */
  private aimFlight(w: WorldView): void {
    const path = this.path;
    const end = path[path.length - 1];
    const total = end.t;
    const elapsed = clamp(this.sincePredict, 0, total);
    const frac = this.isPull
      ? 1
      : TELE.FLIGHT_FRAC + (TELE.FLIGHT_FRAC_HUCK - TELE.FLIGHT_FRAC) * this.huckRamp;
    const tAim = elapsed + frac * Math.max(0, total - elapsed);

    let i = 1;
    while (i < path.length - 1 && path[i].t < tAim) i++;

    // Chord guard. Measured from where the disc is *now* (the prediction's own
    // sample at `elapsed`, which matches the real flight to the millimetre).
    let j = 0;
    while (j < path.length - 1 && path[j].t < elapsed) j++;
    const now = path[j];
    const dx = end.x - now.x, dz = end.z - now.z;
    const len2 = dx * dx + dz * dz;
    if (len2 > 0.25) {
      while (i < path.length - 1) {
        const f = ((path[i].x - now.x) * dx + (path[i].z - now.z) * dz) / len2;
        if (f >= TELE.FLIGHT_FRAC) break;
        i++;
      }
      const p = path[i];
      this.telemetry.leadFrac = ((p.x - now.x) * dx + (p.z - now.z) * dz) / len2;
    } else {
      this.telemetry.leadFrac = 1;
    }

    const p = path[i];
    this.aimTarget.set(p.x, Math.max(p.y, 1.1), p.z);
    this.landing.set(end.x, end.y, end.z);
    // The dolly still tracks the play, not the aim point: gain on the focus Z.
    this.focus.set(p.x, TELE.AIM_Y, p.z);
  }

  /* -------------------------------------------------------------- the lens */

  /** The framing basis, built from the head's real yaw/pitch. */
  private setBasisFromHead(): void {
    const cp = Math.cos(this.pitch);
    _look.set(
      this.pos.x - Math.sin(this.yaw) * cp,
      this.pos.y + Math.sin(this.pitch),
      this.pos.z - Math.cos(this.yaw) * cp,
    );
    this.basis.set(this.pos, _look);
  }

  private inRedZone(w: WorldView): boolean {
    if (w.discFlight) return false;
    if (w.phase !== 'LIVE_POSSESSION' && w.phase !== 'CHECK') return false;
    const goal = w.attackDir * 32;
    return Math.abs(goal - w.disc.z) <= TELE.REDZONE_DIST;
  }

  /**
   * Widen as the play spreads. Solve the field of view that fits the bounding
   * set — disc, offensive players within 30 m of the disc in Z, the thrower,
   * his marker and the selected receiver — into 72% of the frame width, then
   * clamp and rate-limit.
   *
   * The disc is fitted separately and looser (78%). During the first third of a
   * huck the disc is a long way behind the lead point by design; pulling the
   * whole solve tight around it would zoom out on every release and then back
   * in, which is the pumping a broadcast lens never does. The looser guard
   * still keeps it comfortably inside the frame — the disc leaves the shot on
   * no frame of a completed match run.
   */
  private solveFov(w: WorldView, flight: boolean, aspect: number): number {
    const b = this.basis;
    let coreH = 0, coreV = 0, discH = 0, discV = 0;

    const consider = (x: number, y: number, z: number): void => {
      if (!b.tangents(x, y, z, _tan)) return;
      const h = Math.abs(_tan.h), v = Math.abs(_tan.v);
      if (h > coreH) coreH = h;
      if (v > coreV) coreV = v;
    };

    // The anchor of the shot, and both ends of a flight.
    consider(this.aimTarget.x, this.aimTarget.y, this.aimTarget.z);
    if (flight) consider(this.landing.x, Math.max(this.landing.y, 1.0), this.landing.z);

    const refZ = flight ? this.aimTarget.z : w.disc.z;
    for (const p of w.players) {
      const key = p.id === w.throwerId || p.id === w.markerId || p.id === w.receiverId;
      if (!key) {
        if (p.team !== w.offence) continue;
        if (Math.abs(p.z - refZ) > TELE.SPREAD_Z) continue;
      }
      consider(p.x, 1.8, p.z);
    }

    if (b.tangents(w.disc.x, Math.max(w.disc.y, 0.4), w.disc.z, _tan)) {
      discH = Math.abs(_tan.h); discV = Math.abs(_tan.v);
    }

    const base = TELE.FOV_BASE + (TELE.FOV_REDZONE - TELE.FOV_BASE) * this.redRamp;
    const need = Math.max(
      fovForWidth(coreH, TELE.FIT_WIDTH, aspect),
      fovForHeight(coreV, TELE.FIT_HEIGHT),
      fovForWidth(discH, TELE.DISC_GUARD_W, aspect),
      fovForHeight(discV, TELE.DISC_GUARD_H),
      this.guaranteeFov(w, flight, aspect),
    );
    return clamp(
      Math.max(need, base) + TELE.FOV_HUCK_BONUS * this.huckRamp,
      TELE.FOV_MIN, TELE.FOV_MAX);
  }

  /**
   * The lens serving the ≥ 5 guarantee.
   *
   * The spread solve above fits the offence *within 30 m of the disc in Z*, per
   * the brief, and that is the right set for composition — a handler forty
   * metres upfield is not part of this shot and zooming out to include him would
   * throw away the whole point of a long lens. But the brief also asks the shot
   * to hold five offensive bodies while the disc is held, and on a stack that
   * has strung out past 30 m those two rules disagree: the lens sits at 26° with
   * three men off frame while it had four degrees of room in hand.
   *
   * When they disagree the guarantee wins, because it is the one the viewer can
   * see being broken. This returns the narrowest lens on which the fifth-easiest
   * offender is inside the frame — so the rig spends exactly as much of its zoom
   * range as the guarantee costs, and no more. Widening is always the first tool:
   * it costs a little tightness, where `correctFraming`'s skew costs the lead
   * room the composition is built on.
   */
  private guaranteeFov(w: WorldView, flight: boolean, aspect: number): number {
    if (flight || w.throwerId < 0) return 0;
    const b = this.basis;
    const need = this.needs;
    need.length = 0;
    for (const p of w.players) {
      if (p.team !== w.offence) continue;
      if (!b.tangents(p.x, 1.15, p.z, _tan)) continue;
      const f = Math.max(
        fovForWidth(Math.abs(_tan.h), TELE.COUNT_W, aspect),
        fovForHeight(Math.abs(_tan.v), TELE.COUNT_H));
      // Insertion sort, seven elements at the very most.
      let i = need.length;
      need.push(f);
      while (i > 0 && need[i - 1] > f) { need[i] = need[i - 1]; i--; }
      need[i] = f;
    }
    return need.length >= TELE.GUARD_MIN ? need[TELE.GUARD_MIN - 1] : 0;
  }
}

function shortAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

const SKEW_H_TAN = Math.tan(TELE.SKEW_PAN * DEG);
const SKEW_V_TAN = Math.tan(TELE.SKEW_TILT * DEG);

/**
 * Candidate window centres on one axis. Everything is a tangent off the HEAD's
 * axis — literally an NDC coordinate scaled by tan(fov/2) — and `pref` is where
 * the brief's own composition wants the frame centred.
 *
 * `[baseLo, baseHi]` are the bodies that must be inside the hard box of radius
 * `baseR`, which confines the centre to `[baseHi − baseR, baseLo + baseR]`. The
 * candidates are `pref` (the brief's framing, taken whenever it is legal and
 * nothing is gained by leaving it) plus each offender's two box edges, all
 * clamped into that interval. If the hard set does not fit at all — a marker
 * fifteen metres off his thrower with the lens already at its 30° stop — there
 * is no framing that holds it, so centre the set and take the smallest loss.
 */
function windowCentres(
  out: number[], pref: number, vals: readonly number[], valR: number,
  baseLo: number, baseHi: number, baseR: number,
): number[] {
  out.length = 0;
  if (baseHi - baseLo > 2 * baseR) { out.push((baseLo + baseHi) / 2); return out; }
  const lo = baseHi - baseR, hi = baseLo + baseR;
  const fit = (c: number): number => (c < lo ? lo : c > hi ? hi : c);
  out.push(fit(pref));
  for (let i = 0; i < vals.length; i++) {
    out.push(fit(vals[i] - valR));
    out.push(fit(vals[i] + valR));
  }
  return out;
}
