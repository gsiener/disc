import * as THREE from 'three';
import { linearColor } from '../../util/Tex';
import { clamp, smoothstep } from '../../util/Noise';

/**
 * Analytic solar model + the colour palette that hangs off it.
 *
 * The sky system is the authority on where the sun is (`sun:changed`), but the
 * lighting rig must still be correct on its own — a shot can be staged before
 * the sky has spoken, and a stripped build may have no sky at all. So we keep a
 * complete model here and treat the event as an override rather than a source.
 *
 * The arc is deliberately not astronomically real: it is tuned so the named
 * broadcast shots (16.0–19.4 h) all land in raking, long-shadow light and 21.5 h
 * is properly below the horizon.
 */

const DEG = Math.PI / 180;

/** Civil sunrise / sunset in scene hours. Long summer evening — golden shots. */
const SUNRISE = 5.5;
const SUNSET = 20.0;
const NOON = (SUNRISE + SUNSET) * 0.5;
const HALF_DAY = (SUNSET - SUNRISE) * 0.5;

/** Peak elevation at solar noon. Low enough that noon still shapes faces. */
const MAX_ELEV = 58 * DEG;
/** Azimuth (0 = +Z) the sun rises at and sets at. */
const AZ_RISE = 14 * DEG;
const AZ_SET = 201 * DEG;

/** Sun irradiance at full elevation, in three's physical units. */
export const SUN_PEAK = 3.55;

export interface SunState {
  /** Unit vector pointing **toward** the sun. */
  dir: THREE.Vector3;
  /** Linear-space key colour. */
  color: THREE.Color;
  intensity: number;
  /** Radians above the horizon. Negative at night. */
  elevation: number;
  hour: number;
  /** 0 = full day, 1 = sun well below the horizon. */
  night: number;
  /** 0 = day, 1 = deep twilight/night — drives sky and ambient tint. */
  dusk: number;
  /** 0 = floods off, 1 = floods at full. Ramps in before the sun is down. */
  towers: number;
}

/* ------------------------------------------------------------------ ramps */

interface Stop { at: number; c: THREE.Color }

function ramp(stops: Stop[], x: number, out: THREE.Color): THREE.Color {
  if (x <= stops[0].at) return out.copy(stops[0].c);
  const last = stops[stops.length - 1];
  if (x >= last.at) return out.copy(last.c);
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i];
    if (x <= b.at) {
      const a = stops[i - 1];
      const t = (x - a.at) / (b.at - a.at);
      return out.copy(a.c).lerp(b.c, t * t * (3 - 2 * t));
    }
  }
  return out.copy(last.c);
}

const S = (at: number, hex: number): Stop => ({ at, c: linearColor(hex) });

/** Key light colour against elevation in degrees. */
const SUN_RAMP: Stop[] = [
  S(-4, 0xff3d12), S(0.5, 0xff6a24), S(3, 0xff8f44), S(7, 0xffb478),
  S(14, 0xffd6a8), S(26, 0xffe9cd), S(48, 0xfff5ea),
];

/** Zenith sky radiance. */
const ZENITH_RAMP: Stop[] = [
  S(-14, 0x03050c), S(-6, 0x070c1c), S(-1, 0x18294f), S(4, 0x2c4f88),
  S(12, 0x3d70b8), S(30, 0x4a86d8), S(55, 0x5590e2),
];

/** Horizon sky radiance — where the warm band lives. */
const HORIZON_RAMP: Stop[] = [
  S(-14, 0x05070f), S(-6, 0x131627), S(-1.5, 0x5a3b52), S(1.5, 0xd4713e),
  S(5, 0xefa06a), S(13, 0xd8ccc0), S(30, 0xbcd4ee), S(55, 0xc9dcf4),
];

/* ---------------------------------------------------------------- model */

const _tmp = new THREE.Color();

/** Sun elevation (radians) for a scene hour. Negative below the horizon. */
export function elevationAt(hour: number): number {
  const ang = ((hour - NOON) / HALF_DAY) * (Math.PI * 0.5);
  return Math.asin(clamp(Math.sin(MAX_ELEV) * Math.cos(ang), -1, 1));
}

/** Unit vector toward the sun for a scene hour. */
export function directionAt(hour: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ang = ((hour - NOON) / HALF_DAY) * (Math.PI * 0.5);
  const elev = elevationAt(hour);
  const f = clamp(ang / Math.PI + 0.5, -0.35, 1.35);
  const az = AZ_RISE + (AZ_SET - AZ_RISE) * f;
  const ce = Math.cos(elev);
  return out.set(ce * Math.sin(az), Math.sin(elev), ce * Math.cos(az)).normalize();
}

/** Fills `state` from the internal model. Direction/colour may be overridden after. */
export function evaluate(hour: number, state: SunState): SunState {
  directionAt(hour, state.dir);
  applyDerived(hour, state);
  return state;
}

/**
 * Recomputes everything that follows from `dir` — used both by the internal
 * model and after the sky system hands us a direction, so the two paths cannot
 * drift apart.
 */
export function applyDerived(hour: number, state: SunState): void {
  const elev = Math.asin(clamp(state.dir.y, -1, 1));
  const deg = elev / DEG;
  state.elevation = elev;
  state.hour = hour;

  ramp(SUN_RAMP, deg, state.color);

  // Dim through the horizon band, and again as it climbs — a low sun is both
  // redder and weaker because it is burning through far more atmosphere.
  const above = smoothstep(-2.2, 9, deg);
  const high = 0.44 + 0.56 * smoothstep(4, 46, deg);
  state.intensity = SUN_PEAK * above * high;

  state.night = smoothstep(3, -7, deg);
  state.dusk = smoothstep(9, -8, deg);
  state.towers = smoothstep(16, -2, deg);
}

export function makeSunState(): SunState {
  return {
    dir: new THREE.Vector3(0, 1, 0),
    color: new THREE.Color(1, 1, 1),
    intensity: SUN_PEAK,
    elevation: Math.PI / 2,
    hour: 12,
    night: 0,
    dusk: 0,
    towers: 0,
  };
}

/* ------------------------------------------------------------- palettes */

export function zenithColor(elevDeg: number, out = new THREE.Color()): THREE.Color {
  return ramp(ZENITH_RAMP, elevDeg, out);
}

export function horizonColor(elevDeg: number, out = new THREE.Color()): THREE.Color {
  return ramp(HORIZON_RAMP, elevDeg, out);
}

/**
 * Turf albedo used for the bounce lobe. Slightly desaturated from the field's
 * own green — a bounce that is too saturated makes chins look radioactive.
 */
export const TURF_BOUNCE = linearColor(0x4c7a3c);

/** Floodlight colour — metal halide, cool with a faint green cast. */
export const FLOOD_COLOR = linearColor(0xd8e6ff);

/**
 * Resolves a sun direction reported by a peer system into our convention
 * (pointing toward the sun). Some systems publish the direction light travels;
 * we disambiguate against our own model rather than guessing from sign alone,
 * because at night "toward the sun" legitimately points below the horizon.
 */
export function reconcileDirection(
  reported: THREE.Vector3, hour: number, out: THREE.Vector3,
): void {
  out.copy(reported);
  if (out.lengthSq() < 1e-8) { directionAt(hour, out); return; }
  out.normalize();
  directionAt(hour, _ref);
  // Elevation first, azimuth only as a tie-break. Both models agree on where the
  // sun is in *height* at a given hour — that is unambiguous, and it stays
  // unambiguous even when the sun is below the horizon. Azimuth is the part a
  // peer could reasonably disagree with us about, and deciding the sign from a
  // whole-vector dot product means a sky that merely runs a different azimuth
  // arc can flip our key light to the far side of the pitch, which puts every
  // shadow in the frame on the wrong side of every object.
  const dy = Math.abs(out.y - _ref.y);
  const dyFlip = Math.abs(-out.y - _ref.y);
  if (dyFlip < dy - 1e-4) { out.negate(); return; }
  if (dy < dyFlip - 1e-4) return;
  if (out.dot(_ref) < 0) out.negate();
}
const _ref = new THREE.Vector3();

export { _tmp as _solarScratch };
