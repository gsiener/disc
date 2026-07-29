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
    about: 'Character hero shot — chest-up on a receiver, judging skin, cloth, jersey weave, stitching, hair and eyes.',
    pos: [2.1, 1.72, 3.0], target: [0, 1.62, 0], fov: 42, hour: 17.2, tableau: 'portrait', focus: 3.1, aperture: 3.4,
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
    about: 'Establishing wide — whole stadium bowl, stands, lighting rigs, sky, field markings legible.',
    pos: [-72, 44, 78], target: [0, 4, 0], fov: 40, hour: 19.4, tableau: 'flow',
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
    about: 'Night game under stadium lights — four-tower specular on skin and turf, long multi-shadows, bloom on rigs.',
    pos: [-30, 11, 24], target: [0, 1.6, 0], fov: 34, hour: 21.5, tableau: 'flow', focus: 39, aperture: 1.6,
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
