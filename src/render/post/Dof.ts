import * as THREE from 'three';
import { QuadPass, texel } from './Common';

/**
 * Thin-lens depth of field.
 *
 * Circle of confusion follows the real lens relation
 *   CoC ∝ (focal²/N) · |z − focus| / (z · focus)
 * which, factored, is just `|1/focus − 1/z|` scaled by aperture and by the
 * square of the focal length. The focal length is recovered from the camera's
 * vertical FOV, so a telephoto sideline shot naturally gets a shallower depth of
 * field than a wide establishing shot at the same aperture — which is exactly
 * the behaviour the shot list assumes.
 *
 * The gather is a 2.4°-golden-angle Vogel disc, per-pixel rotated. A sample is
 * only allowed to contribute if its own CoC actually reaches the centre pixel,
 * or if it lies at/behind the centre inside the centre's CoC. That single test
 * is what stops sharp backgrounds bleeding onto blurred foregrounds and gives
 * near-field blur that spills *over* the focal plane the way a real lens does.
 *
 * ## Why the foreground is treated differently from the background
 *
 * `1/z` runs away in front of the focal plane and does not run away behind it:
 * a lens focused at 2 m has a bounded circle of confusion at infinity and an
 * unbounded one at 20 cm. Left alone that is exactly what happened to the
 * ground-level turf shot — the metre of grass between the lens and the pitch,
 * i.e. the entire subject of the shot, went to maximum blur while a strip of
 * turf 50 cm deep stayed sharp. So the near lobe gets its own, smaller scale and
 * its own, smaller ceiling. This is not physical and it is not pretending to be;
 * every shipped title does it, because foreground mush destroys a frame in a way
 * background melt never does.
 */
/** Background CoC ceiling as a fraction of frame height. See `maxRadius`. */
const MAX_RADIUS = 0.013;
/**
 * Square pixels of gather per sample the pass refuses to go above.
 *
 * The tier hands this pass a tap count, but a tap count is meaningless without
 * the area it is spread over — and that area lives here, in `maxRadius`. At the
 * 14 px ceiling a 32-tap Vogel disc is one sample per 19 px², which is far too
 * sparse to resolve what is behind it: over a roof truss of one-pixel diagonal
 * members, every pixel's disc hits or misses the same struts as its neighbour's
 * and the gather returns the struts' own orientation as a fixed diagonal
 * cross-hatch stamped across the bokeh. That is the artefact, and no amount of
 * dither cures it because it is not dither, it is undersampling.
 *
 * 6.5 px² per sample — 95 taps at the 1080p ceiling — is where the weave stops
 * resolving and the truss becomes what a lens would actually show: a soft grey.
 *
 * Measured back to back on `closeup`, the worst framing in the shot list
 * (nearly every pixel at the CoC ceiling), 1080p at high:
 *
 *   pass disabled  42.3 ms      32 taps  44.4 ms
 *   64 taps        47.4 ms      96 taps  52.4 ms
 *
 * So the whole pass costs 10 ms there and the rise from the tier's 32 costs 8,
 * and 64 is visibly still stippled where 96 is not. Every gameplay camera
 * early-outs the gather entirely — `broadcast` does not even enable the pass —
 * so this is 8 ms spent on the framings whose entire purpose is to be looked at
 * closely, and nothing anywhere else.
 *
 * Only `high` and `ultra` ever construct this pass (`quality.dof` is false
 * below), so this is not a cost imposed on hardware that asked to be spared;
 * and the 96 clamp keeps a 1.5× DPR panel from quadratically chasing its own
 * ceiling.
 */
const PX2_PER_SAMPLE = 6.5;
const MAX_TAPS = 96;

export class DofPass extends QuadPass {
  /** Metres. */
  focus = 12;
  /** Blur strength scalar taken from the shot list (not an f-number). */
  aperture = 1.0;
  /**
   * Pixels of CoC per unit of `aperture · fovFactor · diopter`.
   *
   * At 0.0011 the pass was numerically inert and the shot list's apertures were
   * decoration. Worked through: `sideline` is a 20° telephoto at aperture 2.4
   * focused at 27 m, and the stand 60 m behind it came out at 1.9 px of blur —
   * under the 0.85 px per-fragment early-out for most of its area, i.e. razor
   * sharp. `layout` put the LED ribbon at 2.0 px, which is why the boards were
   * legible enough to read the sponsor names off, and legible advertising is
   * exactly what the brief says must never be in the top three contrast
   * elements of a frame.
   *
   * 0.0026 is the number that makes each shot deliver what its own `focus` and
   * `aperture` already claim, measured per shot at 1080p:
   *
   *   closeup   crowd at 60 m  → 14 px (capped) — "background is pure bokeh"
   *   sideline  stand at 60 m  → 4.4 px, 120 m → 6.2 px
   *   layout    boards at 50 m → 4.7 px, far stand → 5.5 px
   *   disc      field at 20 m  → 14 px (capped) — "warm field bokeh"
   *   broadcast infinity       → 0.6 px, so the pass still skips itself
   *
   * `broadcast` skipping is correct and not an oversight: a 34° lens at
   * aperture 0.9 focused at 46 m genuinely has nothing out of focus in it, and
   * running a 24-tap gather to produce sub-pixel blur is pure cost.
   */
  scale = 0.0026;
  /**
   * Hard cap on the background blur radius, as a fraction of frame height.
   *
   * 0.0085 was 9.2 px, which no pixel in any shot ever reached — the ceiling
   * was below the floor. 0.013 is 14 px at 1080p, which is what the two macro
   * framings (`closeup`, `disc`) need before their backgrounds actually melt.
   */
  maxRadius = MAX_RADIUS;
  /**
   * Foreground CoC, as a fraction of the background's scale and ceiling.
   *
   * Dropped from 0.45 with the ceiling rise, so the near lobe caps at 4.5 px
   * rather than following the background up to 7.8. The whole of the ground
   * level `turf` framing is foreground — a metre of sward between the lens and
   * the focal plane — and at 7.8 px the sub-pixel blades stopped resolving as
   * blades and started resolving as a directional smear, which is the one thing
   * that shot exists to disprove. The background keeps its full ceiling; only
   * the lobe that sits over the subject is held back.
   */
  nearFraction = 0.32;

  private h = 1080;

  /** Frame index for the sample dither, mod the temporal cycle. See `update`. */
  private phase = 0;
  private lastFocus = -1;
  private lastAperture = -1;

  constructor(width: number, height: number, taps: number) {
    // Taps the *ceiling of this pass* needs to be sampled densely enough to
    // stop reading as a pattern; the tier's number is a floor under it, never a
    // cap. See PX2_PER_SAMPLE.
    const area = Math.PI * Math.pow(height * MAX_RADIUS, 2);
    const dense = Math.min(MAX_TAPS, Math.round(area / PX2_PER_SAMPLE));
    super({
      name: 'DofPass',
      defines: { TAPS: Math.max(taps, dense) },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: texel(width, height) },
        uFocus: { value: 12 },
        uCoCScale: { value: 0 },
        uMaxCoC: { value: 14 },
        uNear: { value: 0.45 },
        uJitter: { value: 0 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2  uTexel;
        uniform float uFocus;
        uniform float uCoCScale;
        uniform float uMaxCoC;
        uniform float uNear;
        uniform float uJitter;
        varying vec2 vUv;

        float cocOf(float z) {
          float c = uCoCScale * (1.0 / uFocus - 1.0 / max(z, 0.05));
          // Negative = in front of the focal plane. See the class note.
          if (c < 0.0) return max(c * uNear, -uMaxCoC * uNear);
          return min(c, uMaxCoC);
        }

        void main() {
          vec3  centre = texture2D(tDiffuse, vUv).rgb;
          float zc = max(texture2D(tDepth, vUv).x, 0.05);
          float cc = cocOf(zc);
          float r  = abs(cc);

          // Below a pixel of blur the gather is a no-op and costs a full disc.
          if (r < 0.85) { gl_FragColor = vec4(centre, 1.0); return; }

          // Interleaved gradient noise rather than a hash: it is low-discrepancy
          // over any small neighbourhood, so a sparse gather over high-frequency
          // content (a stand full of one-pixel crowd) breaks up into a fine
          // ordered dither instead of white speckle.
          //
          // Two things are needed to keep "ordered" from becoming "visible".
          //
          // IGN is a *fixed screen-space pattern*. Left static it does not
          // average out over time, it stands still and reads as a diagonal weave
          // stamped over the bokeh — which is exactly what it was doing across
          // the whole blurred stand in the hero framing. uJitter walks it by a
          // golden 5.588238 px per rendered frame, the standard remedy, so in
          // motion it integrates to grey instead of to a texture.
          //
          // And rotating the disc is not enough on its own. Every pixel shared
          // the same radial ladder sqrt((i+0.5)/TAPS) and differed only in the
          // angle it was rotated to, so neighbouring pixels gathered the same
          // set of ring radii off the same neighbourhood — that shared ladder is
          // the cross-hatch, and no tap count fixes it because adding taps only
          // adds more shared rungs. rj is a decorrelated per-pixel offset that
          // jitters each sample *within its own radial stratum*: the disc stays
          // uniformly covered (the stratification is intact) but no two adjacent
          // pixels sample the same circle any more.
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uJitter, vec2(0.06711056, 0.00583715))));
          float ang = ign * 6.28318530718;
          float ca = cos(ang), sa = sin(ang);
          float rj = hash13(vec3(gl_FragCoord.xy, uJitter + 19.0));

          vec3  sum = centre;
          float wsum = 1.0;

          for (int i = 0; i < TAPS; i++) {
            float fi = float(i) + 0.5;
            float rr = sqrt((float(i) + rj) / float(TAPS));
            float th = fi * 2.39996322973;
            vec2  d  = vec2(cos(th), sin(th));
            d = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);

            float dist = rr * r;
            vec2  uv   = vUv + d * dist * uTexel;
            vec3  s    = texture2D(tDiffuse, uv).rgb;
            float sz   = max(texture2D(tDepth, uv).x, 0.05);
            float sc   = abs(cocOf(sz));

            // Reach: this sample's own blur radius, or the centre's radius if the
            // sample is not in front of the centre (background gather).
            float behind = step(zc - 0.15, sz);
            float reach  = max(sc, behind * r);
            float w      = clamp(reach - dist + 1.0, 0.0, 1.0);

            sum  += s * w;
            wsum += w;
          }

          gl_FragColor = vec4(sum / wsum, 1.0);
        }`,
    });
    this.h = height;
  }

  setDepth(tex: THREE.Texture): void { this.u.tDepth.value = tex; }

  /** Recomputes the CoC scale from the live camera. Returns true if DOF is worth running. */
  update(camera: THREE.PerspectiveCamera): boolean {
    if (!(this.focus > 0) || this.aperture <= 0) return false;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    // (1/tan)² is proportional to focal length squared — the physical CoC term.
    const fovFactor = 1 / (tanHalf * tanHalf);
    const s = this.h * this.scale * this.aperture * fovFactor;
    this.u.uFocus.value = this.focus;
    this.u.uCoCScale.value = s;
    this.u.uMaxCoC.value = this.h * this.maxRadius;
    this.u.uNear.value = this.nearFraction;

    /* Advance the dither's temporal phase by one *rendered frame*.
     *
     * Deliberately not wall-clock: the capture rig steps the simulation by exact
     * fixed dt and then renders, so counting frames here is the same counter
     * `ctx.frame` keeps and the rig stays byte-deterministic. It re-seeds on a
     * hard cut — a shot change moves focus and aperture discontinuously, the
     * same signal the motion-blur pass resets on — so a staged frame is a pure
     * function of its own settle count and not of whichever shots the rig
     * happened to capture before it. Live play moves focus smoothly and never
     * trips it. 64 frames is a bit over a second: long enough that the walk is
     * not a visible cycle, short enough to stay in float precision. */
    const ref = Math.max(this.focus, this.lastFocus);
    const cut = Math.abs(this.focus - this.lastFocus) > 0.25 * ref
      || Math.abs(this.aperture - this.lastAperture) > 1e-3;
    this.phase = cut ? 0 : (this.phase + 1) % 64;
    this.lastFocus = this.focus;
    this.lastAperture = this.aperture;
    this.u.uJitter.value = 5.588238 * this.phase;

    // If the largest plausible CoC in the scene is under a pixel, skip the pass:
    // the gather would early-out per fragment anyway and still cost a
    // full-screen resolve. Worst case over the depth range is z -> infinity.
    return s / this.focus > 0.8;
  }

  override setSize(width: number, height: number): void {
    this.h = height;
    (this.u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
