import * as THREE from 'three';
import type { Ctx, System } from '../core/Ctx';

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { DepthResolvePass } from './post/DepthResolve';
import { DofPass } from './post/Dof';
import { MotionBlurPass } from './post/MotionBlur';
import { GroundSsrPass } from './post/GroundSsr';
import { GradePass, curveFromThree } from './post/Grade';
import { FilmPass } from './post/Film';

/**
 * The post chain.
 *
 *   RenderPass          scene -> HDR half-float buffer (+ a real depth attachment)
 *   DepthResolvePass    that depth attachment -> stable linear view depth
 *   GTAOPass            ground-truth ambient occlusion, tuned at human scale
 *   GroundSsrPass       wet-pitch reflections (ultra only)
 *   DofPass             thin-lens bokeh, driven by the shot's focus/aperture
 *   MotionBlurPass      camera-velocity reprojection blur
 *   UnrealBloomPass     tight, high-threshold bloom on genuine highlights
 *   GradePass           the grade + the single tone map in the whole pipeline
 *   SMAAPass            edge AA, on display-referred data where it belongs
 *   FilmPass            CA / vignette / grain
 *   OutputPass          colour space conversion, last
 *
 * Two things about that ordering are load-bearing.
 *
 * **Optics before the sensor.** Defocus and shutter smear happen in the lens, so
 * DOF and motion blur run *before* bloom — an out-of-focus stadium lamp should
 * bloom as a soft disc, not as a sharp dot that later gets blurred.
 *
 * **Tone mapping happens exactly once.** three skips the material-level tone map
 * whenever it renders into a render target, so everything up to `GradePass` is
 * genuine scene-referred HDR. `GradePass` grades that HDR and then applies the
 * tone curve the renderer asked for; `renderer.toneMapping` is switched to
 * `NoToneMapping` so `OutputPass` degrades to a pure colour-space conversion.
 * The result is one tone map and one gamma encode, with AA and grain landing on
 * display-referred pixels where their thresholds actually mean something.
 */

const BLOOM_STRENGTH = 0.20;
/**
 * Bloom thresholds are *display*-referred, not scene-referred.
 *
 * That distinction is the whole game. `UnrealBloomPass` reads the scene-linear
 * HDR buffer, which at this point has not been exposed yet — the grade applies
 * `toneMappingExposure` later in the chain. And the exposure is not a constant:
 * the solver runs it from 1.7 on a 36° sun to 4.8 at golden hour to 2.5 under
 * floodlights. A fixed scene-linear threshold therefore means something
 * completely different in every shot, which is exactly how the night frame ended
 * up with four 300-pixel white smears across legible sponsor boards while the
 * same number left daylight untouched.
 *
 * So the knee is stated in the units the eye actually judges — "this will clip
 * on screen" — and divided back through the live exposure each frame.
 */
const BLOOM_KNEE_DAY = 7.0;
const BLOOM_KNEE_NIGHT = 4.2;
/**
 * Ceiling on what the pass is allowed to *see*, in the same display-referred
 * units. A floodlight lens is emissive at a few hundred; feeding that straight
 * into a gaussian pyramid turns a 40 cm fixture into a white disc that swallows
 * the roof behind it. Clamping the high-pass seed keeps the halo proportional to
 * the fixture, and the lens itself still clips to white on its own.
 */
const BLOOM_CEIL = 11.0;
/** Mip blend weight. Wide, soft glow over everything is the amateur tell. */
const BLOOM_RADIUS = 0.30;

/**
 * Clamp the bloom pass's high-pass output. `UnrealBloomPass` has no knob for
 * this, so we patch the one line of its luminosity shader that writes the seed.
 * Returns the uniform so the ceiling can track exposure frame by frame.
 */
function clampBloomInput(bloom: UnrealBloomPass, ceiling: number): THREE.IUniform | null {
  const mat = (bloom as unknown as { materialHighPassFilter?: THREE.ShaderMaterial }).materialHighPassFilter;
  if (!mat) return null;
  const SRC = 'gl_FragColor = mix( outputColor, texel, alpha );';
  if (!mat.fragmentShader.includes(SRC)) return null;
  mat.uniforms.uBloomCeiling = { value: ceiling };
  mat.fragmentShader = mat.fragmentShader.replace(SRC, /* glsl */`
      vec4 seed = mix( outputColor, texel, alpha );
      float peak = max( seed.r, max( seed.g, seed.b ) );
      if ( peak > uBloomCeiling ) seed.rgb *= uBloomCeiling / peak;
      gl_FragColor = seed;`)
    .replace('uniform float smoothWidth;', 'uniform float smoothWidth;\n\t\tuniform float uBloomCeiling;');
  mat.needsUpdate = true;
  return mat.uniforms.uBloomCeiling;
}

/** `?post=off` kills the chain; `?post=nobloom,nodof` kills individual effects. */
function postFlags(): Set<string> {
  try {
    const raw = new URLSearchParams(location.search).get('post') ?? '';
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}

export class PostFXSystem implements System {
  readonly name = 'postfx';
  readonly order = 100;

  private composer: EffectComposer | null = null;
  private rt: THREE.WebGLRenderTarget | null = null;

  private renderPass!: RenderPass;
  private depthPass: DepthResolvePass | null = null;
  private gtao: GTAOPass | null = null;
  private ssr: GroundSsrPass | null = null;
  private dof: DofPass | null = null;
  private motion: MotionBlurPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private bloomCeiling: THREE.IUniform | null = null;
  private grade!: GradePass;
  private smaa: SMAAPass | null = null;
  private film!: FilmPass;

  /** Focus/aperture straight off the active shot. focus <= 0 means "no DOF". */
  private focus = 0;
  private aperture = 0;
  /** 0 = daylight, 1 = full night. Drives dew, grain and bloom. */
  private nightness = 0;
  private camera: THREE.PerspectiveCamera | null = null;
  private flags = new Set<string>();
  private toneCurve = THREE.AgXToneMapping as THREE.ToneMapping;

  init(ctx: Ctx): void {
    this.flags = postFlags();
    if (this.flags.has('off')) return;

    const { renderer, scene, quality } = ctx;
    const dpr = renderer.getPixelRatio();
    const pw = Math.max(1, Math.round(ctx.width * dpr));
    const ph = Math.max(1, Math.round(ctx.height * dpr));
    this.camera = ctx.camera;

    // Real depth attachment on the ping-pong target. This is what lets DOF,
    // motion blur and SSR use the *actual* rendered depth — including every
    // vertex-shader displacement — instead of re-rendering the scene with an
    // override material that would not reproduce it.
    const rt = new THREE.WebGLRenderTarget(pw, ph, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(pw, ph),
    });
    rt.texture.name = 'postfx.hdr';
    this.rt = rt;

    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(dpr);
    composer.setSize(ctx.width, ctx.height);
    this.composer = composer;

    /* ------------------------------------------------------------- 1. scene */
    this.renderPass = new RenderPass(scene, ctx.camera);
    composer.addPass(this.renderPass);

    /* ------------------------------------------------------------- 2. depth */
    // Only worth resolving if something downstream consumes it; at the `low`
    // tier nothing does, and it would be a wasted full-screen pass.
    const wantsDof = quality.dof && !this.flags.has('nodof');
    const wantsMb = quality.motionBlur && !this.flags.has('nomb');
    const wantsSsr = quality.ssr && !this.flags.has('nossr');
    const needsDepth = wantsDof || wantsMb || wantsSsr;
    const depthPass = needsDepth
      ? new DepthResolvePass(pw, ph, ctx.camera.near, ctx.camera.far)
      : null;
    if (depthPass) {
      this.depthPass = depthPass;
      composer.addPass(depthPass);
    }

    /* ---------------------------------------------------------------- 3. AO */
    if (quality.ssao && !this.flags.has('noao')) {
      const gtao = new GTAOPass(scene, ctx.camera, pw, ph);
      // Tuned for people, not for the default Stanford-bunny scale.
      //
      // The scoping was already right and is confirmed by measurement: dumping
      // the denoised buffer (`?post=aoonly`) shows open flat grass at ao = 1.0
      // exactly, so the pass lays no grey wash over the largest surface in the
      // frame. What it was *also* doing was finding almost no occlusion on the
      // things it exists for. Measured on `layout` with a player standing at
      // 11 m, before: contact under the foot bottomed out at 0.54, the torso at
      // 0.70, the head and neck at 0.85 — against an open-turf floor of 0.83.
      // The head of a human figure was less occluded than a flat lawn. The
      // beauty A/B (blendIntensity 1 vs 0) moved the image by at most 0.018
      // luma anywhere and typically 0.003: a full-screen pass that was costing
      // its milliseconds and returning nothing.
      //
      // Three of the four geometry parameters were the reason, and each fails
      // in a different way:
      //
      //  - `distanceExponent` 1.8 spaced the six horizon steps as
      //    (j/6)^1.8 · radius, i.e. 2 cm, 7 cm, 14 cm, 24 cm, 36 cm, 50 cm.
      //    Two thirds of every search ray was spent inside the first 15 cm,
      //    where a smooth surface has nothing to find. 1.0 spreads the steps
      //    evenly over the radius, which is what a 0.55 m radius is for.
      //  - `thickness` 0.50 gates every sample on `|viewDelta.z| < thickness`.
      //    A standing player in front of a pitch that recedes for metres has a
      //    silhouette whose depth delta is far more than half a metre, so the
      //    body was being rejected as an occluder of the ground behind it —
      //    which is precisely the contact-shadow case. A metre is the honest
      //    assumed thickness for a human figure.
      //  - `distanceFallOff` 1.0 weights sample j by 2/(j+2), so the outermost
      //    steps counted for a third of the nearest ones and the far half of
      //    the radius was effectively discarded. 0 takes the true horizon,
      //    which is what GTAO integrates; the falloff is an artistic softener
      //    and this pass had nothing left to soften.
      //
      // `scale` is a gamma on the raw occlusion (`ao = pow(ao, scale)`), and
      // because open ground measures exactly 1.0 the gamma is free contrast
      // there — 1^n is 1 at any exponent — while a crease at 0.6 drops to 0.22
      // at 3.0. That asymmetry is the whole point, and it is why the knob was
      // raised rather than the blend intensity, which would have dimmed the
      // pitch along with the armpits.
      // `radius` is 0.42 rather than the 0.55 the first pass at this used: a
      // stand is thirty rows of seat backs and a crowd stacked behind each
      // other, so every centimetre of radius pulls more of the bowl into its
      // own occlusion and the stands were coming back a third darker than the
      // pitch warranted. 0.42 m is still a head-to-shoulder span — it reaches
      // every contact this pass exists for — while halving how many seat rows
      // fall inside it. `distanceFallOff` at 0.3 does the same job along the
      // ray, trimming the outermost steps that are the ones reaching across
      // rows, and leaving the near samples that carry a foot or a chin intact.
      gtao.updateGtaoMaterial({
        radius: 0.42,
        distanceExponent: 1.0,
        thickness: 1.0,
        distanceFallOff: 0.3,
        scale: 2.6,
        samples: quality.tier === 'medium' ? 8 : 16,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({
        lumaPhi: 8, depthPhi: 1.5, normalPhi: 4,
        radius: 4, radiusExponent: 1, rings: 2,
        samples: quality.tier === 'medium' ? 8 : 16,
      });
      gtao.blendIntensity = 1.0;
      // `?post=aoonly` dumps the denoised AO buffer — the only honest way to
      // check that the radius is darkening contact points and not the whole
      // pitch, because a correctly tuned AO term is nearly invisible in beauty.
      if (this.flags.has('aoonly')) gtao.output = GTAOPass.OUTPUT.Denoise;

      // Opt-out hook for peers: anything with `userData.noAO = true` is hidden
      // for GTAO's G-buffer render. GTAO rebuilds depth and normals with a
      // `MeshNormalMaterial` override, which cannot reproduce a custom vertex
      // shader — so wind-displaced grass or GPU-skinned crowd geometry would be
      // occlusion-tested against a silhouette it does not actually have. This
      // lets whoever owns that geometry say so, and it takes the cost with it.
      const baseRender = gtao.render.bind(gtao);
      const hidden: THREE.Object3D[] = [];
      gtao.render = (renderer2, writeBuffer, readBuffer, dt, mask) => {
        hidden.length = 0;
        scene.traverse((o) => {
          if (o.visible && o.userData && o.userData.noAO) { o.visible = false; hidden.push(o); }
        });
        baseRender(renderer2, writeBuffer, readBuffer, dt, mask);
        for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      };

      this.gtao = gtao;
      composer.addPass(gtao);
    }

    /* --------------------------------------------------------------- 4. SSR */
    if (wantsSsr) {
      this.ssr = new GroundSsrPass(pw, ph, 18);
      this.ssr.setDepth(depthPass!.texture);
      composer.addPass(this.ssr);
    }

    /* --------------------------------------------------------------- 5. DOF */
    if (wantsDof) {
      // Tap count has to track the blur ceiling, not the tier's vanity: a Vogel
      // disc gathered at 14 px with 24 taps leaves ~2 px between rim samples,
      // and over a stand full of one-pixel crowd detail that reads as an
      // ordered diagonal weave through the bokeh rather than as bokeh. Sample
      // density goes as taps/radius², so the ceiling rise is paid for here.
      const taps = quality.tier === 'ultra' ? 40 : quality.tier === 'high' ? 32 : 24;
      this.dof = new DofPass(pw, ph, taps);
      this.dof.setDepth(depthPass!.texture);
      composer.addPass(this.dof);
    }

    /* ------------------------------------------------------- 6. motion blur */
    if (wantsMb) {
      this.motion = new MotionBlurPass(pw, ph, quality.tier === 'ultra' ? 12 : 8);
      this.motion.setDepth(depthPass!.texture);
      composer.addPass(this.motion);
    }

    /* ------------------------------------------------------------- 7. bloom */
    if (quality.bloom && !this.flags.has('nobloom')) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(pw, ph), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_KNEE_DAY);
      this.bloomCeiling = clampBloomInput(this.bloom, BLOOM_CEIL);
      composer.addPass(this.bloom);
    }

    /* ------------------------------------------------ 8. grade + tone curve */
    this.grade = new GradePass();
    this.toneCurve = renderer.toneMapping;
    this.grade.setCurve(curveFromThree(this.toneCurve));
    if (this.flags.has('nograde')) {
      // Bypass the look but keep the tone map, so an A/B is still watchable.
      const u = this.grade.material.uniforms;
      u.uContrast.value = 1; u.uSat.value = 1; u.uPostSat.value = 1; u.uPunch.value = 0;
      u.uGreenPush.value = 0; u.uGreenSat.value = 1; u.uSkinGuard.value = 1;
      u.uSkinHue.value = 0; u.uFloat.value = 0; u.uShadowDesat.value = 0;
      (u.uLift.value as THREE.Vector3).set(0, 0, 0);
      (u.uGain.value as THREE.Vector3).set(1, 1, 1);
      (u.uShadowTint.value as THREE.Vector3).set(1, 1, 1);
      (u.uHighTint.value as THREE.Vector3).set(1, 1, 1);
    }
    composer.addPass(this.grade);

    // From here on the buffer is display-referred, so the renderer must not
    // tone map again at the end of the chain.
    renderer.toneMapping = THREE.NoToneMapping;

    /* ---------------------------------------------------------------- 9. AA */
    // SMAA at every tier, including where `quality.taa` is set. three's
    // TAARenderPass is not temporal AA in the modern sense — it is a jittered
    // supersampler that renders the scene 2^sampleLevel times and only
    // converges while the camera is still, and it resolves through its own
    // accumulation target, which means the depth attachment this chain reads
    // never gets written. Paying 4-16 scene renders over a million grass blades
    // to lose DOF, motion blur and SSR is not a trade worth making.
    if (!this.flags.has('noaa')) {
      this.smaa = new SMAAPass();
      composer.addPass(this.smaa);
    }

    /* ------------------------------------------------- 10. lens + film gate */
    this.film = new FilmPass(pw, ph);
    if (this.flags.has('nofilm')) {
      this.film.material.uniforms.uCa.value = 0;
      this.film.material.uniforms.uVignette.value = 0;
      this.film.material.uniforms.uGrain.value = 0;
    }
    composer.addPass(this.film);

    /* -------------------------------------------------- 11. colour space out */
    composer.addPass(new OutputPass());

    ctx.composer = composer;

    ctx.events.on('shot:apply', (p: { shot?: { focus?: number; aperture?: number; hour?: number } }) => {
      const s = p?.shot;
      if (!s) return;
      this.focus = s.focus ?? 0;
      this.aperture = s.aperture ?? 0;
      if (typeof s.hour === 'number') this.setHour(s.hour);
      // A hard camera cut must not reproject against the old view.
      this.motion?.reset();
    });

    ctx.events.on('sun:changed', (p: { hour?: number }) => {
      if (typeof p?.hour === 'number') this.setHour(p.hour);
    });
  }

  /** Dusk/dawn ramp: dew on the turf, more sensor gain, hotter lamps. */
  private setHour(hour: number): void {
    const day = THREE.MathUtils.smoothstep(hour, 5.0, 7.2) * (1 - THREE.MathUtils.smoothstep(hour, 18.4, 20.4));
    this.nightness = 1 - day;
  }

  lateUpdate(_dt: number, ctx: Ctx): void {
    const composer = this.composer;
    if (!composer) return;

    // The camera director may hand us a different camera object at any point.
    if (ctx.camera !== this.camera) {
      this.camera = ctx.camera;
      this.renderPass.camera = ctx.camera;
      if (this.gtao) this.gtao.camera = ctx.camera;
      this.motion?.reset();
    }
    const cam = this.camera!;
    const aspect = cam.aspect || ctx.width / Math.max(1, ctx.height);

    // Somebody re-enabling renderer tone mapping mid-run would double-map the
    // frame; adopt their curve into the grade instead and hand the renderer back
    // to NoToneMapping.
    if (ctx.renderer.toneMapping !== THREE.NoToneMapping) {
      this.toneCurve = ctx.renderer.toneMapping;
      this.grade.setCurve(curveFromThree(this.toneCurve));
      ctx.renderer.toneMapping = THREE.NoToneMapping;
    }
    this.grade.setExposure(ctx.renderer.toneMappingExposure);

    this.depthPass?.setCamera(cam.near, cam.far);

    if (this.dof) {
      this.dof.focus = this.focus > 0 ? this.focus : this.autoFocus(cam);
      this.dof.aperture = this.aperture > 0 ? this.aperture : 1.0;
      this.dof.enabled = this.dof.update(cam);
    }

    if (this.motion) {
      this.motion.enabled = this.motion.update(cam, aspect);
    }

    if (this.ssr) {
      // Night dew — a damp pitch under floodlights is where ground reflections
      // earn their keep; a dry afternoon pitch barely reflects at all.
      this.ssr.wetness = 0.06 + 0.18 * this.nightness;
      this.ssr.enabled = this.ssr.update(cam, aspect);
    }

    if (this.bloom) {
      // Slightly hotter and lower-threshold at night: the only bright things left
      // are the light rigs, and they should read as rigs. Both numbers are
      // converted out of display-referred units through the live exposure — see
      // the constants at the top of this file.
      const exp = Math.max(0.05, ctx.renderer.toneMappingExposure);
      this.bloom.strength = BLOOM_STRENGTH + 0.10 * this.nightness;
      this.bloom.threshold = THREE.MathUtils.lerp(BLOOM_KNEE_DAY, BLOOM_KNEE_NIGHT, this.nightness) / exp;
      if (this.bloomCeiling) this.bloomCeiling.value = BLOOM_CEIL / exp;
    }

    // Higher sensor gain after dark, exactly like a broadcast camera.
    this.film.material.uniforms.uGrain.value = this.flags.has('nofilm')
      ? 0 : 0.022 + 0.016 * this.nightness;
    this.film.setTime(ctx.time);
  }

  /**
   * No shot staged (live play): park the focal plane roughly on the action.
   * A depth read-back would be more accurate but costs a GPU->CPU stall every
   * frame, which is not a trade worth making for a plane this forgiving.
   */
  private autoFocus(cam: THREE.PerspectiveCamera): number {
    return THREE.MathUtils.clamp(cam.position.length() * 0.9, 2, 90);
  }

  resize(w: number, h: number, ctx: Ctx): void {
    const composer = this.composer;
    if (!composer) return;
    composer.setPixelRatio(ctx.renderer.getPixelRatio());
    composer.setSize(w, h);
  }

  dispose(): void {
    this.composer?.dispose();
    this.rt?.dispose();
    this.composer = null;
  }
}
