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
      // Tuned for people, not for the default Stanford-bunny scale. A 0.45 m
      // world radius is roughly a shoulder width: it darkens armpits, under
      // chins, the seam where a cleat meets the turf and the treads of the
      // stands, and it dies out to nothing across open flat grass because there
      // is no occluder within half a metre. The steep distance exponent keeps it
      // from turning distant crowd geometry into grey mud.
      gtao.updateGtaoMaterial({
        radius: 0.45,
        distanceExponent: 1.8,
        thickness: 0.55,
        distanceFallOff: 0.9,
        scale: 1.15,
        samples: quality.tier === 'medium' ? 8 : 16,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({
        lumaPhi: 8, depthPhi: 1.5, normalPhi: 4,
        radius: 4, radiusExponent: 1, rings: 2,
        samples: quality.tier === 'medium' ? 8 : 16,
      });
      gtao.blendIntensity = 0.9;
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
      this.dof = new DofPass(pw, ph, quality.tier === 'ultra' ? 32 : 24);
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
      // Threshold is in scene-referred linear. Sunlit turf sits well under 1,
      // so nothing on the field blooms; only the sun disc, lamp housings, and
      // hot speculars on sweat and on the disc's rim clear the bar. Radius is
      // kept modest — a wide, soft glow over the whole frame is the single most
      // reliable way to make a render look amateur.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(pw, ph), 0.42, 0.55, 2.0);
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
      // Slightly hotter and slightly wider at night: the only bright things left
      // are the light rigs, and they should read as rigs.
      this.bloom.strength = 0.42 + 0.16 * this.nightness;
      this.bloom.threshold = 2.0 - 0.55 * this.nightness;
    }

    // Higher sensor gain after dark, exactly like a broadcast camera.
    this.film.material.uniforms.uGrain.value = this.flags.has('nofilm')
      ? 0 : 0.032 + 0.022 * this.nightness;
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
