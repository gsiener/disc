import { clamp, mix } from '../../util/Noise';
import type { SunState } from './Solar';

/**
 * Exposure control.
 *
 * The grade runs AgX, which has a wide latitude but still needs to be told where
 * middle grey is. Rather than a magic constant per shot, we estimate the
 * irradiance actually landing in the scene from our own rig and solve for the
 * exposure that puts turf a little under middle grey — then bias the target down
 * at night so a floodlit game reads as a floodlit game instead of a slightly
 * blue noon.
 *
 * Estimating instead of measuring keeps this deterministic (no readback, no
 * frame lag, identical output on every machine) and it degrades sanely if a
 * peer sky publishes a sun intensity on some other scale: whatever they choose,
 * the frame stays exposed.
 *
 * The `ambient` term must be the *whole* indirect budget — IBL plus probe plus
 * wrap. It used to be the probe alone while the image-based light quietly
 * contributed twice as much again, which meant every daylight frame was metered
 * against about half the light it was actually receiving.
 */

/** Irradiance that should map to a well-exposed daylight frame. */
const DAY_TARGET = 3.85;
/**
 * Same, at night — lower, so the floodlit pitch keeps its contrast.
 *
 * Nudged up from 2.85 because the estimate below is now honest and it was not
 * before: the LED ring drove four unshadowable area lights that put roughly ten
 * units on the run-off, none of which appeared in `e`, so the frame was being
 * exposed for 1.5 units while receiving 11 and the boards clipped a 900 px
 * strip to paper white. With the spill segmented and cut to a fifth, the solve
 * and the scene agree, and the pitch can be given the extra sixth of a stop it
 * was previously stealing from the highlights.
 *
 * Then 3.15 → 3.95, measured rather than guessed: mid-pitch turf was landing at
 * 0.28 post-grade luma against a brief that asks for 0.30–0.40. Note what this
 * number does and does not control. Because the meter and the rig are solved
 * against each other, *turf brightness depends only on this target* — raising
 * the floodlights alone moves nothing, it just closes the aperture by the same
 * factor. What raising the floodlights moves is everything with a fixed
 * emission (LED boards, lens glass), which is why the two numbers were changed
 * together: the rig went up 2.5× and this went up 1.25×, so the turf gains a
 * third of a stop and the boards lose a full stop.
 */
const NIGHT_TARGET = 3.95;

const MIN_EXPOSURE = 0.35;
/**
 * Golden hour is genuinely dark on a horizontal surface — a 6° sun puts about a
 * twentieth of noon's irradiance on the pitch — and the ceiling has to be high
 * enough to let those shots open up instead of silently clipping to a muddy
 * under-exposure. It is a stop and a half above what the shot list needs.
 */
const MAX_EXPOSURE = 6.00;

export class Exposure {
  value = 1;
  /** Debug read-out: the irradiance estimate the value was solved from. */
  estimate = 0;

  private target = 1;

  /**
   * @param ambient  total indirect irradiance on an up-facing surface.
   * @param tower    irradiance from the floodlight rig at pitch level.
   */
  evaluate(sun: SunState, ambient: number, tower: number): number {
    const sunUp = Math.max(0, Math.sin(sun.elevation));
    const lumaCol = 0.2126 * sun.color.r + 0.7152 * sun.color.g + 0.0722 * sun.color.b;
    // Metering a scene, not a light meter lying on the grass. A grazing sun puts
    // very little on the pitch but a great deal on every vertical surface — the
    // crowd, the stands, the players — so the estimate blends the horizontal
    // cosine with a floor that stands in for all that upright geometry.
    const key = sun.intensity * lumaCol * (0.28 + 0.62 * sunUp);
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
