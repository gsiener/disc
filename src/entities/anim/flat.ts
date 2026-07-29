import * as THREE from 'three';

/**
 * Flat-array quaternion helpers, retyped.
 *
 * `@types/three` declares these statics as taking `number[]`, but both only ever
 * index their arguments — a `Float32Array` is valid at runtime and is what poses
 * are actually stored in here (a boxed `number[]` per bone, per skeleton, at
 * 120 Hz across 14 players is a great deal of avoidable GC pressure).
 *
 * Aliasing them once with the honest signature keeps the cast in a single place
 * instead of scattering `as unknown as number[]` across every call site.
 */
export type FlatQuat = Float32Array | number[];

export const slerpFlat = THREE.Quaternion.slerpFlat as unknown as (
  dst: FlatQuat, dstOffset: number,
  src0: FlatQuat, srcOffset0: number,
  src1: FlatQuat, srcOffset1: number,
  t: number,
) => void;

export const multiplyQuaternionsFlat = THREE.Quaternion.multiplyQuaternionsFlat as unknown as (
  dst: FlatQuat, dstOffset: number,
  src0: FlatQuat, srcOffset0: number,
  src1: FlatQuat, srcOffset1: number,
) => FlatQuat;
