import * as THREE from 'three';
import {
  Basis, SpringVec3, clamp, fovForHeight, fovForWidth, isLivePhase,
  type CamPlayer, type PathPoint, type WorldView,
} from './View.ts';
import { TELE } from './Tele.ts';

/**
 * THE CUT LIBRARY, and the one rule that governs it.
 *
 * Ultimate has no dead ball after a catch. Play is continuous — a completion is
 * not a whistle, it is the next possession starting mid-stride — so the whole
 * Madden grammar of cutting between plays has nowhere to attach. Every cut here
 * therefore hangs off a phase the rules machine actually goes dead in
 * (`TURNOVER_DEAD`, `CHECK`, `POINT_SCORED`, `TIMEOUT`, `HALFTIME`,
 * `PRE_PULL`), and there are ZERO cuts while `gs.phase` is `LIVE_POSSESSION`,
 * `DISC_IN_FLIGHT` or `PULL_IN_FLIGHT`.
 *
 * The single scripted exception is the pull aerial handing off to the tele at
 * 60% of the pull's flight time. That one is legal for a reason specific to the
 * sport: the pull is uncontested by rule — `tryCatch` will not even let the
 * pulling team touch it — so nothing can happen during it that a cut could make
 * you miss.
 *
 * Grammar, enforced here and asserted in tools/test-camera.ts:
 *   - minimum shot length 2.5 s;
 *   - every sideline camera at x <= -6, so screen-left is the same field
 *     direction all point long;
 *   - the endzone camera is the one permitted reverse angle, |x| <= 8.
 */

export type ShotKind = 'tele' | 'pullAerial' | 'lowEndzone' | 'celebration';

/** Which side of the line of play a shot lives on. */
export const SHOT_SIDE: Record<ShotKind, 'sideline' | 'endzone'> = {
  tele: 'sideline',
  pullAerial: 'sideline',
  lowEndzone: 'endzone',
  celebration: 'sideline',
};

export const CUTS = {
  MIN_SHOT: 2.5,
  /** Max |x| for a camera on the sideline side of the line of play. */
  SIDELINE_X: -6,
  /** Max |x| for the endzone reverse angle. */
  ENDZONE_X: 8,

  /* pull aerial */
  AERIAL_X: -30,
  AERIAL_Y: 30,
  AERIAL_BEHIND: 12,
  AERIAL_PUSH: 1.5,
  AERIAL_FOV_MIN: 28,
  AERIAL_FOV_MAX: 40,
  AERIAL_FIT: 0.80,
  /** Fraction of predicted pull flight at which the tele takes over. */
  HANDOFF: 0.60,

  /* low endzone */
  ENDZONE_Y: 2.2,
  ENDZONE_Z: 56,
  ENDZONE_FOV: 28,
  /** Disc must be this close to the attacked goal line for the cut. */
  ENDZONE_RED: 20,
  /** ...and no offender this close to it, or the restart is imminent. */
  ENDZONE_CLEAR: 8,

  /* celebration */
  CELEB_DELAY: 0.7,
  CELEB_DIST: 12,
  CELEB_Y: 1.6,
  CELEB_FOV: 24,
} as const;

const _v = new THREE.Vector3();
const _tan = { h: 0, v: 0 };

export interface CutTelemetry {
  shot: ShotKind;
  /** Seconds the current shot has been on air. */
  age: number;
  cuts: number;
  /** True only on the frame a cut lands. */
  cutThisFrame: boolean;
  /** Length of the shot that just ended, on a cut frame. */
  lastShotLength: number;
  /** Cuts that had to break the 2.5 s minimum to get back to the tele. */
  forced: number;
  /** 0..1 through the predicted pull flight; drives the one legal live cut. */
  pullFrac: number;
}

/**
 * Decides which camera is on air, and drives every camera that is not the tele.
 * The tele is driven by `TeleRig` and merely selected here.
 */
export class ShotMachine {
  shot: ShotKind = 'tele';
  age = 0;
  cuts = 0;
  cutThisFrame = false;
  lastShotLength = 0;
  forced = 0;

  /** Framing of the active non-tele shot. */
  readonly pos = new THREE.Vector3(-42, 15, 0);
  readonly aim = new SpringVec3();
  fov = 30;

  private readonly want = new THREE.Vector3();
  private readonly basis = new Basis();
  private started = false;
  private pullTotal = 0;
  private pullFrac = 0;
  private sincePredict = 1e3;

  readonly telemetry: CutTelemetry = {
    shot: 'tele', age: 0, cuts: 0, cutThisFrame: false,
    lastShotLength: 0, forced: 0, pullFrac: 0,
  };

  /* ------------------------------------------------------------------ step */

  /** Returns true when a cut landed this frame. */
  update(dt: number, w: WorldView, aspect: number): boolean {
    const step = Math.max(1e-4, Math.min(dt, 0.1));
    this.cutThisFrame = false;
    this.age += step;
    this.trackPull(step, w);

    if (!this.started) {
      // Opening frame: adopt the right camera without calling it a cut.
      this.started = true;
      this.shot = this.desired(w);
      this.age = 0;
      this.enter(w, aspect);
    } else {
      const want = this.desired(w);
      if (want !== this.shot && this.mayCut(w, want)) {
        this.lastShotLength = this.age;
        this.shot = want;
        this.age = 0;
        this.cuts++;
        this.cutThisFrame = true;
        this.enter(w, aspect);
      }
    }

    if (this.shot !== 'tele') this.drive(step, w, aspect);

    const t = this.telemetry;
    t.shot = this.shot; t.age = this.age; t.cuts = this.cuts;
    t.cutThisFrame = this.cutThisFrame; t.lastShotLength = this.lastShotLength;
    t.forced = this.forced; t.pullFrac = this.pullFrac;
    return this.cutThisFrame;
  }

  apply(cam: THREE.PerspectiveCamera): void {
    cam.position.copy(this.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.aim.value);
    if (Math.abs(cam.fov - this.fov) > 1e-4) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  /* --------------------------------------------------------------- policy */

  private desired(w: WorldView): ShotKind {
    switch (w.phase) {
      case 'PRE_PULL':
        return 'pullAerial';
      case 'PULL_IN_FLIGHT':
        return this.pullFrac >= CUTS.HANDOFF ? 'tele' : 'pullAerial';
      case 'LIVE_POSSESSION':
      case 'DISC_IN_FLIGHT':
        return 'tele';
      case 'POINT_SCORED':
        return w.phaseTimer >= CUTS.CELEB_DELAY ? 'celebration' : this.shot;
      case 'TURNOVER_DEAD':
      case 'CHECK':
        if (this.shot === 'lowEndzone') return 'lowEndzone';
        return this.endzoneWorthwhile(w) ? 'lowEndzone' : 'tele';
      default:
        return 'tele';
    }
  }

  /**
   * The low endzone is only worth taking if the disc will sit there long enough
   * to be a shot. The turnover beat (0.8 s of the tele holding still) has to
   * have played, the disc has to be in the red zone, and nobody can be about to
   * pick it up — eight metres of running plus the pick-up dwell plus the check
   * is comfortably longer than the 2.5 s minimum, which is how this shot keeps
   * the grammar without needing to predict the future.
   */
  private endzoneWorthwhile(w: WorldView): boolean {
    if (w.phase !== 'TURNOVER_DEAD') return false;
    if (w.phaseTimer < TELE.TURNOVER_HOLD) return false;
    const goal = w.attackDir * 32;
    if (Math.abs(goal - w.disc.z) > CUTS.ENDZONE_RED) return false;
    let near = Infinity;
    for (const p of w.players) {
      if (p.team !== w.offence) continue;
      near = Math.min(near, Math.hypot(p.x - w.disc.x, p.z - w.disc.z));
    }
    return near >= CUTS.ENDZONE_CLEAR;
  }

  private mayCut(w: WorldView, want: ShotKind): boolean {
    const live = isLivePhase(w.phase);
    const handoff = live && this.shot === 'pullAerial' && want === 'tele'
      && w.phase === 'PULL_IN_FLIGHT';

    // THE HARD RULE. Inside a live phase the only cut is the pull handoff —
    // and the frame the phase itself changes, which is a boundary, not a cut
    // across live action.
    if (live && !w.phaseChanged && !handoff) return false;
    if (this.age >= CUTS.MIN_SHOT) return true;

    // Sitting on a dead-ball camera while the disc is live is worse than a
    // short shot; those two cases, and only those, may break the minimum.
    if (handoff || (live && want === 'tele')) { this.forced++; return true; }
    return false;
  }

  /* ---------------------------------------------------------------- shots */

  private enter(w: WorldView, aspect: number): void {
    switch (this.shot) {
      case 'pullAerial': {
        const d = w.pullDir;
        this.pos.set(CUTS.AERIAL_X, CUTS.AERIAL_Y, -d * (32 + CUTS.AERIAL_BEHIND));
        this.aimPoint(w);
        this.aim.set(this.want.x, this.want.y, this.want.z);
        this.fov = this.fitAerial(w, aspect);
        break;
      }
      case 'lowEndzone': {
        this.pos.set(
          clamp(w.disc.x * 0.5, -CUTS.ENDZONE_X, CUTS.ENDZONE_X),
          CUTS.ENDZONE_Y,
          w.attackDir * CUTS.ENDZONE_Z,
        );
        this.aim.set(w.disc.x, 1.0, w.disc.z);
        this.fov = CUTS.ENDZONE_FOV;
        break;
      }
      case 'celebration': {
        const s = this.playerOf(w, w.scorerId) ?? { x: w.disc.x, y: 1.2, z: w.disc.z };
        // Low sideline, 12 m off the scorer, downfield of him so the shot has
        // his face rather than his number. Held on the -X side of the line of
        // play like every other sideline camera.
        const camX = Math.min(s.x - CUTS.CELEB_DIST, CUTS.SIDELINE_X - 2);
        const dx = s.x - camX;
        const back = Math.sqrt(Math.max(0, CUTS.CELEB_DIST * CUTS.CELEB_DIST - dx * dx));
        this.pos.set(camX, CUTS.CELEB_Y, clamp(s.z + w.attackDir * back, -58, 58));
        this.aim.set(s.x, 1.45, s.z);
        this.fov = CUTS.CELEB_FOV;
        break;
      }
      default: break;
    }
  }

  private drive(dt: number, w: WorldView, aspect: number): void {
    switch (this.shot) {
      case 'pullAerial': {
        // A slow push-in along the view axis. Broadcast aerials never sit still
        // and never move fast; 1.5 m/s over the four seconds of a pull is about
        // six metres, which reads as intent rather than as drift.
        _v.copy(this.aim.value).sub(this.pos);
        const len = _v.length();
        if (len > 12) this.pos.addScaledVector(_v.divideScalar(len), CUTS.AERIAL_PUSH * dt);
        this.aimPoint(w);
        this.aim.step(this.want, 2.2, dt);
        this.fov = approachFov(this.fov, this.fitAerial(w, aspect), dt);
        break;
      }
      case 'lowEndzone': {
        this.want.set(w.disc.x, Math.max(1.0, w.disc.y), w.disc.z);
        this.aim.step(this.want, 2.6, dt);
        break;
      }
      case 'celebration': {
        const s = this.playerOf(w, w.scorerId);
        if (s) this.want.set(s.x, 1.45, s.z); else this.want.copy(this.aim.value);
        this.aim.step(this.want, 2.4, dt);
        break;
      }
      default: break;
    }
  }

  /** Where the aerial looks: down-field before the pull, at the flight during. */
  private aimPoint(w: WorldView): void {
    const d = w.pullDir;
    if (w.phase === 'PULL_IN_FLIGHT') {
      // Midway between the disc and where it will land — both ends of the pull
      // stay in the frame, which is the whole job of an establishing aerial.
      const land = this.landing(w);
      this.want.set(
        (w.disc.x + land.x) * 0.5,
        Math.max(2, (w.disc.y + land.y) * 0.5),
        (w.disc.z + land.z) * 0.5,
      );
      return;
    }
    this.want.set(clamp(w.disc.x * 0.5, -9, 9), 2, -d * 8);
  }

  private readonly landPt = new THREE.Vector3();
  private landing(w: WorldView): THREE.Vector3 {
    let path: readonly PathPoint[] = [];
    try { path = w.predict(); } catch { path = []; }
    if (path.length < 2) return this.landPt.set(w.disc.x, 0.5, w.pullDir * 12);
    const e = path[path.length - 1];
    return this.landPt.set(e.x, e.y, e.z);
  }

  /** Fit the pull — disc, landing spot and both goal lines — into 80% width. */
  private fitAerial(w: WorldView, aspect: number): number {
    const b = this.basis.set(this.pos, this.aim.value);
    let h = 0, v = 0;
    const consider = (x: number, y: number, z: number): void => {
      if (!b.tangents(x, y, z, _tan)) return;
      h = Math.max(h, Math.abs(_tan.h));
      v = Math.max(v, Math.abs(_tan.v));
    };
    consider(w.disc.x, Math.max(w.disc.y, 0.6), w.disc.z);
    consider(0, 1.6, -w.pullDir * 32);
    consider(0, 1.6, w.pullDir * 32);
    if (w.phase === 'PULL_IN_FLIGHT') {
      const l = this.landing(w);
      consider(l.x, Math.max(l.y, 0.6), l.z);
    }
    const need = Math.max(
      fovForWidth(h, CUTS.AERIAL_FIT, aspect),
      fovForHeight(v, CUTS.AERIAL_FIT),
    );
    return clamp(need, CUTS.AERIAL_FOV_MIN, CUTS.AERIAL_FOV_MAX);
  }

  private playerOf(w: WorldView, id: number): CamPlayer | null {
    if (id < 0) return null;
    for (const p of w.players) if (p.id === id) return p;
    return null;
  }

  /* ----------------------------------------------------------------- pull */

  private trackPull(dt: number, w: WorldView): void {
    if (w.phase !== 'PULL_IN_FLIGHT') {
      this.pullFrac = 0;
      this.pullTotal = 0;
      this.sincePredict = 1e3;
      return;
    }
    this.sincePredict += dt;
    if (this.sincePredict >= TELE.PREDICT_DT) {
      this.sincePredict = 0;
      let path: readonly PathPoint[] = [];
      try { path = w.predict(); } catch { path = []; }
      if (path.length >= 2) {
        this.pullTotal = Math.max(0.5, w.phaseTimer + path[path.length - 1].t);
      }
    }
    this.pullFrac = this.pullTotal > 0 ? clamp(w.phaseTimer / this.pullTotal, 0, 1) : 0;
  }
}

/** Aerial zoom is rate-limited too, at the tele's 7 deg/s. */
function approachFov(cur: number, to: number, dt: number): number {
  const max = TELE.FOV_RATE * dt;
  const d = to - cur;
  return cur + (d > max ? max : d < -max ? -max : d);
}
