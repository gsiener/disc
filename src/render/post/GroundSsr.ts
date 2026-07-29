import * as THREE from 'three';
import { QuadPass, texel } from './Common';

/**
 * Ultra-tier screen-space reflections, restricted to the pitch.
 *
 * three's stock `SSRPass` cannot sit in this chain: it re-renders the whole
 * scene (beauty + normals + metalness) and writes the result over the read
 * buffer, which would throw away ambient occlusion and cost a second pass over
 * a million grass blades. It also derives normals from an override-material
 * render, so on wind-displaced grass its normals disagree with the pixels it is
 * reflecting.
 *
 * This does the useful half of the job for a fraction of the cost. Reflections
 * on a sports pitch are ground reflections; the pitch is flat, so instead of
 * reconstructing (extremely noisy, per-blade) normals from depth, fragments
 * near y = 0 are reflected about the world up-vector. That is both noise-free
 * and geometrically right for wet turf. The contribution is Fresnel-weighted,
 * so it only shows at the grazing angles where wet grass actually mirrors —
 * broadcast and night angles pick up a sheen; a top-down look picks up nothing.
 */
export class GroundSsrPass extends QuadPass {
  /** 0..1 surface wetness. Raised at night when dew sets in. */
  wetness = 0.25;
  /** Metres of ray march. */
  maxDistance = 24;
  /** Depth-buffer thickness heuristic, metres. */
  thickness = 1.4;

  private readonly upWorld = new THREE.Vector3(0, 1, 0);
  private readonly upView = new THREE.Vector3();
  private readonly nrm = new THREE.Matrix3();

  constructor(width: number, height: number, steps: number) {
    super({
      name: 'GroundSsrPass',
      defines: { SSR_STEPS: steps },
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uTexel: { value: texel(width, height) },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
        uStrength: { value: 0.25 },
        uMaxDist: { value: 24 },
        uThickness: { value: 1.4 },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2  uTexel;
        uniform vec2  uTanHalf;
        uniform mat4  uProj;
        uniform mat4  uCamWorld;
        uniform vec3  uUpView;
        uniform float uStrength;
        uniform float uMaxDist;
        uniform float uThickness;
        varying vec2 vUv;

        void main() {
          vec3 base = texture2D(tDiffuse, vUv).rgb;
          float z = texture2D(tDepth, vUv).x;
          if (z > 90.0) { gl_FragColor = vec4(base, 1.0); return; }

          vec3 vp = viewFromDepth(vUv, z, uTanHalf);
          vec4 wp = uCamWorld * vec4(vp, 1.0);

          // Only the playing surface reflects. Grass tips sit ~0.06 m up.
          float ground = smoothstep(0.55, 0.08, wp.y);
          if (ground < 0.01) { gl_FragColor = vec4(base, 1.0); return; }

          vec3 v = normalize(vp);                 // camera -> fragment
          float ndv = max(dot(-v, uUpView), 0.0);
          float fres = pow(1.0 - ndv, 5.0);       // Schlick; grazing only
          float w = ground * fres * uStrength * smoothstep(90.0, 40.0, z);
          if (w < 0.003) { gl_FragColor = vec4(base, 1.0); return; }

          vec3 r = reflect(v, uUpView);
          float jit = hash13(vec3(gl_FragCoord.xy, 11.0));
          float step0 = uMaxDist / float(SSR_STEPS);

          float hitW = 0.0;
          vec2  hitUv = vUv;
          // Jitter only the entry point, not the whole march — scaling every
          // step by the hash would make the ray length itself random.
          float travelled = step0 * 0.3 * jit;
          float hitDist = 0.0;

          for (int i = 0; i < SSR_STEPS; i++) {
            // Geometrically growing steps: dense near the contact point where
            // the reflection reads, coarse far away where it does not.
            travelled += step0 * (0.30 + float(i) * 0.16);
            if (travelled > uMaxDist) break;

            vec3 q = vp + r * travelled;
            vec4 cp = uProj * vec4(q, 1.0);
            if (cp.w <= 0.0) break;
            vec2 uv = (cp.xy / cp.w) * 0.5 + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

            float sz = texture2D(tDepth, uv).x;
            float diff = -q.z - sz;
            if (diff > 0.03 && diff < uThickness) {
              float edge = smoothstep(0.0, 0.14, min(uv.x, 1.0 - uv.x))
                         * smoothstep(0.0, 0.14, min(uv.y, 1.0 - uv.y));
              float fade = 1.0 - travelled / uMaxDist;
              hitUv = uv;
              hitDist = travelled;
              hitW = edge * fade * fade;   // squared: the streak dies quickly
              break;
            }
          }

          if (hitW <= 0.0) { gl_FragColor = vec4(base, 1.0); return; }

          // Grass is rough. A mirror-sharp streak on turf reads as an artefact,
          // so the hit is gathered over a lobe that widens with ray length —
          // the cheap stand-in for a roughness-driven reflection cone.
          float spread = (2.0 + hitDist * 2.5) ;
          vec3 refl = vec3(0.0);
          for (int k = 0; k < 4; k++) {
            float a = (float(k) + jit) * 1.57079633;
            vec2 o = vec2(cos(a), sin(a)) * spread * uTexel;
            refl += texture2D(tDiffuse, clamp(hitUv + o, vec2(0.0), vec2(1.0))).rgb;
          }
          refl *= 0.25;
          // Clamp fireflies so a floodlight does not paint a hard dot on turf.
          refl = min(refl, vec3(4.0));
          gl_FragColor = vec4(base + refl * (w * hitW), 1.0);
        }`,
    });
  }

  setDepth(tex: THREE.Texture): void { this.u.tDepth.value = tex; }

  update(camera: THREE.PerspectiveCamera, aspect: number): boolean {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    (this.u.uTanHalf.value as THREE.Vector2).set(tanHalf * aspect, tanHalf);
    (this.u.uProj.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (this.u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);

    this.nrm.setFromMatrix4(camera.matrixWorldInverse);
    this.upView.copy(this.upWorld).applyMatrix3(this.nrm).normalize();
    (this.u.uUpView.value as THREE.Vector3).copy(this.upView);

    this.u.uStrength.value = this.wetness;
    this.u.uMaxDist.value = this.maxDistance;
    this.u.uThickness.value = this.thickness;
    return this.wetness > 0.001;
  }

  override setSize(width: number, height: number): void {
    (this.u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
