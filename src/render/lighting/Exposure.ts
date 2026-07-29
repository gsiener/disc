import { clamp, mix } from '../../util/Noise';
import type { SunState } from './Solar';

/**
 * Exposure control.
 *
 * The renderer runs AgX, which has a wide latitude but still needs to be told
 * where middle grey is. Rather than a magic constant per shot, we estimate the
 * irradiance actually landing on the pitch from our own rig and solve for the
 * exposure that puts turf near middle grey — then bias the target down at night
 * so a floodlit game reads as a floodlit game instead of a slightly blue noon.
 *
 * Estimating instead of measuring keeps this deterministic (no readback, no
 * frame lag, identical output on every machine) and it degrades sanely if a
 * peer sky publishes a sun intensity on some other scale: whatever they choose,
 * the frame stays exposed.
 */

/** Irradiance that should map to a well-exposed daylight frame. */
const DAY_TARGET = 3.30;
/** Same, at night — lower, so the floodlit pitch keeps its contrast. */
const NIGHT_TARGET = 2.05;

const MIN_EXPOSURE = 0.42;
const MAX_EXPOSURE = 2.30;

export class Exposure {
  value = 1;
  /** Debug read-out: the irradiance estimate the value was solved from. */
  estimate = 0;

  private target = 1;

  /**
   * @param ambient  irradiance from sky + bounce (roughly the probe's DC term).
   * @param tower    irradiance from the floodlight rig at pitch level.
   */
  evaluate(sun: SunState, ambient: number, tower: number): number {
    const sunUp = Math.max(0, Math.sin(sun.elevation));
    // A grazing sun lights the turf far less than its intensity suggests, so
    // weight by the cosine but never let it collapse to zero while it is up.
    const key = sun.intensity * (0.16 + 0.84 * sunUp);
    const e = key + ambient + tower;
    this.estimate = e;

    const targetIrr = mix(DAY_TARGET, NIGHT_TARGET, sun.night);
    // A touch more exposure through golden hour — the classic broadcast look is
    // slightly hot, with the sky rolling off rather than sitting mid-grey.
    const golden = 1 + 0.10 * (sun.dusk - sun.night);
    this.target = clamp((targetIrr / Math.max(e, 0.05)) * golden, MIN_EXPOSURE, MAX_EXPOSURE);
    return this.target;
  }

  /** Exponential approach; `snap` jumps straight there (shot changes, boot). */
  step(dt: number, snap: boolean): number {
    if (snap || Math.abs(this.target - this.value) < 1e-4) {
      this.value = this.target;
    } else {
      const k = 1 - Math.exp(-dt * 3.2);
      this.value += (this.target - this.value) * k;
    }
    return this.value;
  }
}
