import * as THREE from 'three';
import type { Ctx } from '../core/Ctx';

/**
 * Named, deterministic scenarios used by the screenshot rig and by the visual
 * critics. Each shot pins the camera, the time of day, and a gameplay tableau so
 * the same name always produces the same frame — that is what makes an
 * iteration loop meaningful (a change in the image means a change in the code).
 *
 * Systems opt in by listening for `shot:apply`. Anything that does not listen is
 * simply unaffected; the camera placement below always applies.
 */
export interface Shot {
  /** Human description — shown to critics so they know what they are judging. */
  about: string;
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** 0..24 hours; drives sun elevation and sky. */
  hour: number;
  /** Optional gameplay tableau id consumed by the game-state system. */
  tableau?: string;
  /** Focus distance override for depth of field, in metres. */
  focus?: number;
  aperture?: number;
}

export const SHOTS = {
  broadcast: {
    about: 'Primary broadcast angle — elevated sideline, full 7v7 in frame, mid-point offence working the disc upfield.',
    pos: [-34, 15.5, 30], target: [0, 1.6, 4], fov: 34, hour: 16.5, tableau: 'flow', focus: 46, aperture: 0.9,
  },
  sideline: {
    about: 'Low sideline telephoto — compressed depth, handler pivoting against a mark, defenders behind.',
    pos: [-26, 1.35, 12], target: [2, 1.5, 2], fov: 20, hour: 17.8, tableau: 'mark', focus: 27, aperture: 2.4,
  },
  closeup: {
    // A HERO PORTRAIT, SOLVED RATHER THAN GUESSED.
    //
    // The old framing sat 3.66 m out on a 42° lens, which is a 2.81 m vertical
    // field: a 235 mm head came out 117 px tall in a 1080 frame with the whole
    // three-quarter figure in shot and the bottom third bare turf. Nothing this
    // shot exists to judge — weave, stitching, hair fibre, iris — resolves at
    // 117 px, so the framing was quietly excusing every character defect it was
    // supposed to expose.
    //
    // The numbers below are derived from the rig's own measurements rather than
    // dialled in. `Skeleton.ts` builds a 0.235 m head; the posed athlete's crown
    // lands at y ≈ 1.57 and his eye line at y ≈ 1.44. Wanting the head at 40 %
    // of frame height fixes the vertical field at 0.235 / 0.40 = 0.59 m, and
    // 0.59 = 2·D·tan(fov/2) then fixes the distance once a focal length is
    // chosen. 26° is the shortest lens that still reads as a portrait — 45°
    // horizontal, about a 43 mm equivalent — and it puts the lens 1.38 m out.
    //
    // The camera sits AT the subject's eye height and tilts down 5.4°, which is
    // the classic answer: the face is seen level (no nostril, no crown), while
    // the axis dropping below the eye line puts the eyes on the upper third and
    // spends the lower two-thirds on shoulder and chest. Frame top lands 6 cm
    // over the crown, frame bottom at y ≈ 0.99 — the bottom of the ribcage.
    // `Game.tableauPortrait` stands the athlete at `focus` down the view axis,
    // so `focus` and the framing are the same number by construction.
    //
    // Aperture is NOT the old 3.4. `Dof.ts` scales the circle of confusion by
    // 1/tan²(fov/2), so shortening the lens and closing to 1.38 m multiplies the
    // CoC by 4.6 at the same aperture: 3.4 would put 11 px of blur 13 cm behind
    // the focal plane and mush the far ear, the far shoulder and the hair mass —
    // i.e. blur out most of what the shot is for. 0.6 holds ±5 cm inside the
    // pass's own sub-pixel early-out (the whole face is genuinely resolved) and
    // still runs the background to the 14 px blur ceiling, because at 1.38 m
    // focus everything past 15 m is at the cap regardless.
    about: 'Character hero shot — chest-up on a receiver, judging skin, cloth, jersey weave, stitching, hair and eyes.',
    pos: [0.79, 1.44, 1.13], target: [0, 1.31, 0], fov: 26, hour: 17.2, tableau: 'portrait', focus: 1.38, aperture: 0.6,
  },
  layout: {
    about: 'Peak-action layout — receiver fully extended horizontal, disc at fingertips, turf spray, defender trailing.',
    pos: [7.5, 1.1, 9.0], target: [0, 0.85, 0], fov: 30, hour: 16.0, tableau: 'layout', focus: 11.5, aperture: 1.8,
  },
  disc: {
    about: 'Disc in flight — macro on a spinning disc mid-huck, motion trail, field bokeh behind.',
    pos: [3.2, 2.4, 3.4], target: [0, 2.2, 0], fov: 26, hour: 18.2, tableau: 'huck', focus: 4.4, aperture: 4.5,
  },
  stadium: {
    // The bowl's roof reaches x = ±59, z = ±90, y = 27.6, and the floodlight
    // masts stand at (±48, ±79) with heads at y = 43.5. Anything inside that
    // envelope frames a truss, not a stadium — this sits well outside it and
    // high enough to look down into the bowl and read the pitch markings.
    about: 'Establishing wide — whole stadium bowl, stands, lighting rigs, sky, field markings legible.',
    pos: [-134, 82, 150], target: [0, 15, 0], fov: 42, hour: 19.4, tableau: 'flow',
  },
  turf: {
    about: 'Ground-level turf macro — individual grass blades, mow stripes, chalk line edge, cleat divots.',
    pos: [0.9, 0.16, 1.5], target: [-1.2, 0.03, -1.6], fov: 34, hour: 17.5, tableau: 'flow', focus: 2.0, aperture: 5.0,
  },
  crowd: {
    about: 'Stands detail — packed crowd with readable individuals, team colours, banners, depth falloff.',
    pos: [-30, 6.5, 26], target: [-46, 9, 22], fov: 30, hour: 18.6, tableau: 'flow', focus: 19, aperture: 2.8,
  },
  endzone: {
    about: 'Endzone score — catch completed in the endzone, celebration, crowd behind, low sun flare.',
    pos: [4, 2.2, -46], target: [-1, 1.7, -54], fov: 36, hour: 18.9, tableau: 'score', focus: 9, aperture: 2.2,
  },
  night: {
    // "BLOOM ON RIGS" NEEDS A RIG IN FRAME.
    //
    // The old camera — [-30, 11, 24] on a 34° lens aimed at the centre circle —
    // put the entire top edge of the frame inside the far stand: no mast, no
    // roofline, no sky at all. Half of what this shot claims to show was
    // unachievable from that camera whatever the renderer did.
    //
    // The masts (`stadium/Layout.ts`) stand at (±44.5, ±74.6) with their fixture
    // clusters at y 36.7. From anywhere on this touchline only the far-corner
    // mast, tower 3 at (44.5, −74.6), is both in front of the lens and near the
    // sightline — and it sits 25° above the pitch centre and ~10° to screen left
    // of it. Fitting a 30° subject-to-mast separation needs the frame opened to
    // 42° and the axis lifted until it clears the far roof.
    //
    // The camera cannot simply retreat to gain the angle: `Game.tableauFlow`
    // composes the whole play at 37–46 m *down the view axis*, so a camera much
    // further out than ~40 m from the centre spot pushes the arrangement off the
    // sideline and into `at()`'s clamp. Distance is therefore held and the
    // framing bought with fov and pitch instead: mast head in the top-left, the
    // roof rim and the sky's glow dome across the top third, the four-shadow
    // group in the lower right where the tableau already puts it.
    //
    // Aperture rises 1.6 → 2.4 only to keep the pass alive: `Dof.ts` skips
    // itself when the worst CoC in frame is under a pixel, and the CoC scale
    // carries 1/tan²(fov/2), so widening 34° → 42° costs 1.6 stops of blur.
    about: 'Night game under stadium lights — four-tower specular on skin and turf, long multi-shadows, bloom on rigs.',
    pos: [-35, 12, 27], target: [0.6, 9.9, 8.9], fov: 42, hour: 21.5, tableau: 'flow', focus: 40, aperture: 2.4,
  },
} as const satisfies Record<string, Shot>;

export type ShotName = keyof typeof SHOTS;

const _pos = new THREE.Vector3();
const _tgt = new THREE.Vector3();

export function applyShot(name: ShotName, ctx: Ctx): void {
  const shot = SHOTS[name] as Shot;
  if (!shot) throw new Error(`Unknown shot "${name}"`);

  // Systems (sky, game state, camera director) react to this first…
  ctx.events.emit('shot:apply', { name, shot });

  // …then we hard-pin the camera so the framing is never left to a director.
  _pos.fromArray(shot.pos);
  _tgt.fromArray(shot.target);
  ctx.camera.position.copy(_pos);
  ctx.camera.lookAt(_tgt);
  ctx.camera.fov = shot.fov;
  ctx.camera.updateProjectionMatrix();
  ctx.camera.updateMatrixWorld(true);

  ctx.events.emit('shot:applied', { name, shot });
}
