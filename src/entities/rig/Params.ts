import { HAIR_STYLES } from './Types.ts';
import type { BodyParams, FaceParams, HairStyle } from './Types.ts';

/**
 * Roster generation. Fourteen players have to read as fourteen humans from the
 * broadcast camera, which means the variation that matters is the one visible in
 * *silhouette at 40 m*: standing height, shoulder-to-hip ratio, limb length and
 * hair. Face parameters only pay off in the closeup, so they are drawn wide —
 * there is no cost to two players having very different noses.
 *
 * The distributions are deliberately not uniform. Ultimate at club level is a
 * lean endurance sport played by a mixed-gender roster, so height is bimodal-ish
 * around 1.72/1.83, body fat sits low, and muscle skews wiry rather than bulky.
 */

interface RandLike { next(): number; range(lo: number, hi: number): number; gauss(): number; pick<T>(a: readonly T[]): T; }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function randomFace(rand: RandLike): FaceParams {
  const u = () => rand.next();
  return {
    jaw: u(), chin: u(), brow: u() * 0.85 + 0.08, nose: u(), noseW: u(),
    cheek: u() * 0.9 + 0.05, eyeW: u(), eyeOpen: 0.30 + u() * 0.62,
    lips: u(), ears: u(), skull: 0.20 + u() * 0.70,
  };
}

export function randomBodyParams(rand: RandLike, opts: { hair?: HairStyle } = {}): BodyParams {
  // Two overlapping height modes rather than one wide normal: a single Gaussian
  // hands you fourteen people who are all almost exactly average.
  const tall = rand.next() < 0.48;
  const height = clamp(
    (tall ? 1.845 : 1.715) + rand.gauss() * 0.055,
    1.62, 2.03,
  );
  const frame = clamp(tall ? 0.22 + rand.next() * 0.42 : 0.34 + rand.next() * 0.56, 0, 1);
  const muscle = clamp(0.30 + rand.gauss() * 0.19 + (1 - frame) * 0.14, 0.05, 0.95);
  const fat = clamp(0.16 + Math.abs(rand.gauss()) * 0.16, 0.03, 0.62);

  return {
    height,
    shoulder: clamp(1 + rand.gauss() * 0.048 + (0.5 - frame) * 0.055, 0.88, 1.12),
    chest: clamp(1 + rand.gauss() * 0.042 + muscle * 0.045, 0.90, 1.12),
    waist: clamp(0.97 + rand.gauss() * 0.050 + fat * 0.17, 0.86, 1.16),
    hip: clamp(1 + rand.gauss() * 0.040 + frame * 0.075, 0.90, 1.14),
    muscle, fat, frame,
    legRatio: clamp(1 + rand.gauss() * 0.021, 0.95, 1.06),
    armRatio: clamp(1 + rand.gauss() * 0.021, 0.95, 1.06),
    neck: clamp(1 + rand.gauss() * 0.055 + muscle * 0.055 - frame * 0.055, 0.86, 1.16),
    headSize: clamp(1 + rand.gauss() * 0.021, 0.94, 1.06),
    face: randomFace(rand),
    hair: opts.hair ?? pickHair(rand, frame),
    hairBulk: clamp(1 + rand.gauss() * 0.16, 0.70, 1.35),
    seed: Math.floor(rand.next() * 0xffffff),
  };
}

function pickHair(rand: RandLike, frame: number): HairStyle {
  // Longer styles are more common on the higher-`frame` end of the roster, but
  // never exclusively — a bun on a broad-shouldered player is not a bug.
  const r = rand.next();
  const longBias = 0.22 + frame * 0.44;
  if (r < longBias * 0.34) return 'ponytail';
  if (r < longBias * 0.58) return 'bun';
  if (r < longBias * 0.74) return 'long';
  if (r < longBias * 0.86) return 'locs';
  const rest = HAIR_STYLES.filter((h) => h === 'buzz' || h === 'short' || h === 'crop');
  return rand.pick(rest);
}

/** A neutral 1.80 m reference athlete — used by tests and the preview harness. */
export function referenceBodyParams(): BodyParams {
  return {
    height: 1.80, shoulder: 1, chest: 1, waist: 1, hip: 1,
    muscle: 0.42, fat: 0.16, frame: 0.25,
    legRatio: 1, armRatio: 1, neck: 1, headSize: 1,
    face: {
      jaw: 0.62, chin: 0.55, brow: 0.55, nose: 0.50, noseW: 0.45,
      cheek: 0.55, eyeW: 0.50, eyeOpen: 0.62, lips: 0.45, ears: 0.5, skull: 0.5,
    },
    hair: 'short', hairBulk: 1, seed: 1,
  };
}
