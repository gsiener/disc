import * as THREE from 'three';
import {
  Basis, DEG, SpringVec3, approach, approachAngle, clamp, dollyVelocity,
  fovForHeight, fovForWidth, spring1,
  type PathPoint, type Spring1, type WorldView,
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

  private readonly basis = new Basis();
  private readonly focus = new THREE.Vector3();
  private readonly landing = new THREE.Vector3();

  readonly telemetry: TeleTelemetry = {
    panRate: 0, tiltRate: 0, zoomRate: 0, dollySpeed: 0,
    leadFrac: 1, huck: 0, redZone: 0, frozen: false,
  };

  /* ------------------------------------------------------------------ step */

  update(dt: number, w: WorldView, aspect: number): void {
    const t = this.telemetry;
    const step = Math.max(1e-4, Math.min(dt, 0.1));

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
      this.dollyVel = 0;
      this.aim.set(this.aim.value.x, this.aim.value.y, this.aim.value.z);
      this.fovSpring.v = 0;
      t.panRate = 0; t.tiltRate = 0; t.zoomRate = 0; t.dollySpeed = 0;
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
    const dx = aim.x - this.pos.x, dy = aim.y - this.pos.y, dz = aim.z - this.pos.z;
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
    const dx = this.aim.value.x - this.pos.x;
    const dy = this.aim.value.y - this.pos.y;
    const dz = this.aim.value.z - this.pos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.pitch = Math.asin(clamp(dy / len, -1, 1));
    this.yaw = Math.atan2(-dx / len, -dz / len);

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

  private solveAim(w: WorldView, flight: boolean): void {
    if (flight) { this.aimFlight(w); return; }
    this.aimHeld(w);
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
    );
    return clamp(
      Math.max(need, base) + TELE.FOV_HUCK_BONUS * this.huckRamp,
      TELE.FOV_MIN, TELE.FOV_MAX);
  }
}

function shortAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}
