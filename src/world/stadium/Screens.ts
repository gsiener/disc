import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { canvasTexture } from '../../util/Tex';
import type { Ctx } from '../../core/Ctx';
import { Mesher, parts, strut, mat, UNIT_BOX, type Part, type RGB } from './Geo';
import type { StadiumMaterials } from './Materials';
import { BASE_PERIMETER, BOWL, ROOF, SCREENS, ptAt, ringTable, type RingPt } from './Layout';

/**
 * Everything that emits pixels: the pitch-side LED perimeter ring, the ribbon
 * board along the roof's leading edge, and the corner jumbotrons.
 *
 * All three run the same LED shader — the panel content is sampled through a
 * dot mask with an RGB sub-pixel tint, a slight scan darkening and a pixel
 * grid, and the mask cross-fades out as the LED pitch approaches one screen
 * pixel so it never aliases. Content is procedural: fictional brands only.
 *
 * The perimeter ring also drives four RectAreaLights so the boards actually
 * throw colour onto the turf, which is the strongest "this is a broadcast"
 * cue there is.
 */

/**
 * The vertex stage deliberately mirrors three's own boilerplate (`common`,
 * `fog_pars_vertex`, `fog_vertex`, and `mvPosition`/`worldPosition` in scope)
 * so that peer systems which patch fog chunks via onBeforeCompile — the sky's
 * aerial perspective, for one — find the anchors they expect on these
 * materials too.
 */
const LED_VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 transformed = vec3( position );
    vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
    vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const LED_FRAG = /* glsl */`
  #include <common>
  uniform sampler2D uMap;
  uniform float uTime;
  uniform float uScroll;
  uniform vec2  uGrid;      // LED dots across the quad, in uv space
  uniform float uGain;
  uniform float uSub;       // rgb sub-pixel strength
  uniform float uCurve;     // brightness falloff toward panel edges
  varying vec2 vUv;
  #include <fog_pars_fragment>

  void main() {
    vec2 uv = vec2( vUv.x + uTime * uScroll, vUv.y );
    vec3 c = texture2D( uMap, uv ).rgb;

    // Dot mask, faded out once one LED is smaller than a screen pixel.
    vec2 g = vUv * uGrid;
    float fw = max( fwidth( g.x ), fwidth( g.y ) );
    float vis = clamp( 1.0 - fw * 1.6, 0.0, 1.0 );
    vec2 f = fract( g ) - 0.5;
    float d = max( abs( f.x ), abs( f.y ) ) * 2.0;
    // NB: never name a local 'dot' — peer systems inject GLSL after this and
    // a local of that name shadows the built-in for everything downstream.
    float ledMask = 1.0 - smoothstep( 0.62, 0.98, d );

    // RGB stripe: each dot is three vertical emitters.
    float sub = fract( g.x * 3.0 );
    vec3 stripe = vec3(
      1.0 - smoothstep( 0.0, 0.34, abs( sub - 0.166 ) ),
      1.0 - smoothstep( 0.0, 0.34, abs( sub - 0.5   ) ),
      1.0 - smoothstep( 0.0, 0.34, abs( sub - 0.833 ) ) );
    vec3 mask = mix( vec3( 1.0 ), mix( vec3( 0.55 ), stripe * 1.9, 0.85 ), uSub * vis );

    float scan = 1.0 - 0.10 * vis * step( 0.5, fract( g.y ) );
    float edge = 1.0 - uCurve * pow( abs( vUv.y * 2.0 - 1.0 ), 6.0 );

    vec3 outc = c * mask * mix( 1.0, ledMask, vis ) * scan * edge * uGain;
    outc += c * 0.16 * uGain;      // panel bleed so blacks are never pure black

    gl_FragColor = vec4( outc, 1.0 );
    #include <fog_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface LedPanel {
  mat: THREE.ShaderMaterial;
}

export interface ScreensBuild {
  group: THREE.Group;
  perimeter: THREE.ShaderMaterial;
  ribbon: THREE.ShaderMaterial;
  jumbo: THREE.ShaderMaterial;
  /** Redraws the jumbotron content canvas. */
  refresh(ctx: Ctx): void;
  setNight(k: number): void;
}

const _p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };

/**
 * Board-spill emitter strength, in nits, per 9.5 m panel run.
 *
 * A real perimeter board runs 4–6 000 cd/m² and the turf a metre in front of it
 * is visibly lifted; ten metres out it is not. These two numbers put roughly
 * 1.3 units of irradiance on the turf directly in front of a board at night and
 * a tenth of that at mid-pitch — a readable band, not a wash. The old single
 * 92 m emitter at 25 nits delivered about 10 units across the whole run-off,
 * which is why it clipped.
 */
const SPILL_DAY = 0.9;
const SPILL_NIGHT = 5.0;

function ledMaterial(map: THREE.Texture, grid: THREE.Vector2, gain: number, scroll: number, sub: number, curve: number) {
  // UniformsUtils.merge deep-clones values, so the texture is attached after.
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uMap: { value: null },
        uTime: { value: 0 },
        uScroll: { value: scroll },
        uGrid: { value: grid.clone() },
        uGain: { value: gain },
        uSub: { value: sub },
        uCurve: { value: curve },
      },
    ]),
    vertexShader: LED_VERT,
    fragmentShader: LED_FRAG,
    toneMapped: true,
    fog: true,
    side: THREE.FrontSide,
  });
  m.uniforms.uMap.value = map;
  return m;
}

export function buildScreens(ctx: Ctx, M: StadiumMaterials, rows: number, ringN: number): ScreensBuild {
  const g = new THREE.Group();
  g.name = 'screens';
  const lowTier = ctx.quality.tier === 'low';

  /* ------------------------------------------------- pitch-side LED ring */
  const adTex = bakeAdStrip(ctx);
  const AD_RUN = 48;            // metres of pitch covered by one pass of the strip
  const BOARD_LO = 0.20, BOARD_HI = 1.28;
  const boardH = BOARD_HI - BOARD_LO;

  const perimeterMat = ledMaterial(
    adTex, new THREE.Vector2(AD_RUN / boardH * 44, 44), 1.5, 0.0075, 0.55, 0.10,
  );
  perimeterMat.name = 'led-perimeter';

  const led = new Mesher();
  const tTab = ringTable(ringN, 0);
  const N = tTab.length - 1;
  const ringPts: RingPt[] = [];
  for (let i = 0; i <= N; i++) {
    const p: RingPt = { x: 0, z: 0, nx: 0, nz: 0, t: 0, seg: 0 };
    ptAt(tTab[i] % 1, 0, p);
    p.t = tTab[i];
    ringPts.push(p);
  }
  for (let i = 0; i < N; i++) {
    const a = ringPts[i], b = ringPts[i + 1];
    const off = -0.06;
    const ax = a.x + a.nx * off, az = a.z + a.nz * off;
    const bx = b.x + b.nx * off, bz = b.z + b.nz * off;
    const u0 = a.t * BASE_PERIMETER / AD_RUN, u1 = b.t * BASE_PERIMETER / AD_RUN;
    led.quad(
      [ax, BOARD_LO, az], [bx, BOARD_LO, bz], [bx, BOARD_HI, bz], [ax, BOARD_HI, az],
      [u0, 0, u1, 0, u1, 1, u0, 1],
    );
  }
  const ledMesh = new THREE.Mesh(led.build('led-perimeter'), perimeterMat);
  ledMesh.name = 'led-perimeter';
  g.add(ledMesh);

  /* ------------------------------------------------- roof ribbon board */
  const ribbonMat = ledMaterial(
    adTex, new THREE.Vector2(AD_RUN / ROOF.fasciaH * 30, 30), 1.15, -0.011, 0.4, 0.06,
  );
  ribbonMat.name = 'led-ribbon';
  const ribbon = new Mesher();
  const fOff = ROOF.frontOff - 0.09;
  for (let i = 0; i < N; i++) {
    const a = ringPts[i], b = ringPts[i + 1];
    const ax = a.x + a.nx * fOff, az = a.z + a.nz * fOff;
    const bx = b.x + b.nx * fOff, bz = b.z + b.nz * fOff;
    const u0 = a.t * BASE_PERIMETER / AD_RUN, u1 = b.t * BASE_PERIMETER / AD_RUN;
    const lo = ROOF.frontY - ROOF.fasciaH + 0.12, hi = ROOF.frontY - 0.1;
    ribbon.quad(
      [ax, lo, az], [bx, lo, bz], [bx, hi, bz], [ax, hi, az],
      [u0, 0, u1, 0, u1, 1, u0, 1],
    );
  }
  g.add(new THREE.Mesh(ribbon.build('led-ribbon'), ribbonMat));

  /* ---------------------------------------------------------- jumbotrons */
  const jumboCanvas = document.createElement('canvas');
  jumboCanvas.width = 1024; jumboCanvas.height = 576;
  drawJumbotron(jumboCanvas.getContext('2d')!, 1024, 576, 0);
  const jumboTex = new THREE.CanvasTexture(jumboCanvas);
  jumboTex.colorSpace = THREE.SRGBColorSpace;
  jumboTex.wrapS = jumboTex.wrapT = THREE.ClampToEdgeWrapping;
  jumboTex.minFilter = THREE.LinearFilter;
  jumboTex.generateMipmaps = false;

  const jumboMat = ledMaterial(
    jumboTex, new THREE.Vector2(lowTier ? 128 : 224, lowTier ? 72 : 126), 1.7, 0, 0.75, 0.05,
  );
  jumboMat.name = 'led-jumbo';

  const screens = new Mesher();
  const frameParts: Part[] = [];
  const caseParts: Part[] = [];
  const FRAME: RGB = [0.35, 0.36, 0.38];
  for (const s of SCREENS) {
    const yaw = s.yaw;
    const dx = Math.sin(yaw), dz = Math.cos(yaw);   // facing direction
    const tx = dz, tz = -dx;                        // screen right
    const hw = s.w / 2, hh = s.h / 2;
    const [px, py, pz] = s.pos;
    const ox = px + dx * 0.16, oz = pz + dz * 0.16;
    screens.quad(
      [ox - tx * hw, py - hh, oz - tz * hw], [ox + tx * hw, py - hh, oz + tz * hw],
      [ox + tx * hw, py + hh, oz + tz * hw], [ox - tx * hw, py + hh, oz - tz * hw],
      [0, 0, 1, 0, 1, 1, 0, 1],
    );
    // Clad backing box. Corner boards are seen from *behind* by half the
    // establishing shots, so the back has to read as equipment rather than as
    // an open rectangle of black lattice hanging over the roof.
    caseParts.push({
      geo: UNIT_BOX,
      m: mat(px - dx * 1.15, py, pz - dz * 1.15, 0, yaw, 0, s.w + 0.9, s.h + 0.9, 2.1),
      color: [1.0, 1.0, 1.0],
      uvScale: 0.6,
    });

    // Bezel + backing box + support legs down onto the bowl.
    const b = 0.55;
    const corners: [number, number, number][][] = [
      [[-hw - b, -hh - b, 0], [hw + b, -hh - b, 0]],
      [[-hw - b, hh + b, 0], [hw + b, hh + b, 0]],
      [[-hw - b, -hh - b, 0], [-hw - b, hh + b, 0]],
      [[hw + b, -hh - b, 0], [hw + b, hh + b, 0]],
    ];
    const toWorld = (v: [number, number, number]): [number, number, number] => [
      px + tx * v[0] - dx * v[2], py + v[1], pz + tz * v[0] - dz * v[2],
    ];
    for (const [a, c] of corners) frameParts.push({ ...strut(toWorld(a), toWorld(c), 0.6, UNIT_BOX), color: FRAME });
    // rear frame lattice (positive local z is behind the screen)
    for (let i = -2; i <= 2; i++) {
      const x = (i / 2) * hw;
      frameParts.push({ ...strut(toWorld([x, -hh, 1.1]), toWorld([x, hh, 1.1]), 0.26, UNIT_BOX), color: FRAME });
      frameParts.push({ ...strut(toWorld([x, hh, 1.1]), toWorld([x, hh, 0]), 0.2, UNIT_BOX), color: FRAME });
      frameParts.push({ ...strut(toWorld([x, -hh, 1.1]), toWorld([x, -hh, 0]), 0.2, UNIT_BOX), color: FRAME });
    }
    for (let i = -1; i <= 1; i++) {
      const y = i * hh * 0.85;
      frameParts.push({ ...strut(toWorld([-hw, y, 1.1]), toWorld([hw, y, 1.1]), 0.22, UNIT_BOX), color: FRAME });
    }
    // Braced legs from the screen down on to the roof's top skin — `baseY` is
    // the canopy height directly under the board, so nothing floats.
    for (const sxs of [-0.72, 0.72]) {
      const top = toWorld([sxs * hw, -hh - b, 0.8]);
      const foot: [number, number, number] = [top[0], s.baseY, top[2]];
      frameParts.push({ ...strut(foot, top, 0.85, UNIT_BOX), color: FRAME });
      for (let k = 0; k < 5; k++) {
        const y0 = foot[1] + (k / 5) * (top[1] - foot[1]);
        const y1 = foot[1] + ((k + 1) / 5) * (top[1] - foot[1]);
        frameParts.push({ ...strut([top[0] - tx * 1.5, y0, top[2] - tz * 1.5], [top[0] + tx * 1.5, y1, top[2] + tz * 1.5], 0.16, UNIT_BOX), color: FRAME });
      }
    }
  }
  const jumboMesh = new THREE.Mesh(screens.build('jumbotrons'), jumboMat);
  jumboMesh.name = 'jumbotrons';
  g.add(jumboMesh);
  const frames = new THREE.Mesh(parts(frameParts, 'jumbo-frames'), M.steelDark);
  frames.castShadow = ctx.quality.tier !== 'low';
  frames.receiveShadow = true;
  g.add(frames);
  // Light-metal cladding, kept off the dark-steel material so the back of a
  // corner board reads as a housing rather than a hole in the establishing shot.
  const cases = new THREE.Mesh(parts(caseParts, 'jumbo-cases'), M.steel);
  cases.castShadow = ctx.quality.tier !== 'low';
  cases.receiveShadow = true;
  g.add(cases);

  /* ------------------------------------------------------- light spill */
  //
  // A board ring is not one light. It used to be modelled as four: each an
  // emitter 92 m long — the entire touchline — driven to 25 nits at night.
  // A RectAreaLight of that size puts roughly ten units of irradiance on the
  // turf in front of it (E ≈ L·h/d for a long strip), which is three times a
  // midday sun, and three.js RectAreaLights cannot cast a shadow *ever*. So
  // the night frame was carrying key-strength fill that nothing could occlude:
  // the run-off clipped to paper white and no object on the pitch had a dark
  // side. Every shadow in the shot was being erased by the advertising.
  //
  // Segmented instead, one emitter per panel run. The falloff along the
  // touchline becomes spatial (each segment is a local source obeying its own
  // inverse square) rather than a uniform wash, peak drops by 5×, and the LED
  // emissive — which is what a viewer actually reads as "the boards are on" —
  // carries the rest. Pass/fail is the sponsor text staying legible at the
  // exposure that puts the pitch at middle grey.
  if (!lowTier) {
    RectAreaLightUniformsLib.init();
    /** Panel run length, metres. Matches a real perimeter board module. */
    const SEG_W = 9.5;
    const segs = ctx.quality.tier === 'medium' ? [3, 1] : [4, 2];
    const mk = (x: number, z: number, yaw: number) => {
      const l = new THREE.RectAreaLight(0xd8e4ff, SPILL_DAY, SEG_W, boardH * 1.6);
      l.position.set(x, (BOARD_LO + BOARD_HI) * 0.5, z);
      l.rotation.set(0, yaw, 0);
      l.name = 'led-spill';
      g.add(l);
    };
    /** Evenly spaced segment centres over a straight run of half-length `half`. */
    const centres = (n: number, half: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(((i + 0.5) / n * 2 - 1) * half);
      return out;
    };
    // Yaw so each light's -Z (its emission axis) points at the pitch.
    const zx = BOWL.hx - 0.2, zz = BOWL.hz - 0.2;
    for (const c of centres(segs[0], BOWL.hz - BOWL.cornerR)) {
      mk(zx, c, Math.PI / 2);
      mk(-zx, c, -Math.PI / 2);
    }
    for (const c of centres(segs[1], BOWL.hx - BOWL.cornerR)) {
      mk(c, zz, 0);
      mk(c, -zz, Math.PI);
    }
  }

  let clockPhase = 0;

  return {
    group: g,
    perimeter: perimeterMat,
    ribbon: ribbonMat,
    jumbo: jumboMat,
    refresh(c: Ctx) {
      clockPhase = c.time;
      drawJumbotron(jumboCanvas.getContext('2d')!, 1024, 576, clockPhase);
      jumboTex.needsUpdate = true;
    },
    setNight(k: number) {
      // Night gains are held just under the bloom threshold: an LED board that
      // clips to white is a board whose sponsor you cannot read, which is the
      // opposite of what perimeter advertising is for.
      perimeterMat.uniforms.uGain.value = 1.35 + k * 1.05;
      ribbonMat.uniforms.uGain.value = 1.0 + k * 0.95;
      jumboMat.uniforms.uGain.value = 1.5 + k * 1.15;
      for (const c of g.children) {
        if ((c as THREE.RectAreaLight).isRectAreaLight) {
          (c as THREE.RectAreaLight).intensity = SPILL_DAY + k * (SPILL_NIGHT - SPILL_DAY);
        }
      }
    },
  };
}

/* ------------------------------------------------------------ ad content */

/** Fictional sponsors — eight panels, each 1/8 of the strip. */
const BRANDS: { name: string; tag: string; bg: string; fg: string; accent: string }[] = [
  { name: 'AEROGRIP', tag: 'DISC TECHNOLOGY', bg: '#0b1b2c', fg: '#f2f6f9', accent: '#37c8ff' },
  { name: 'NIMBUS', tag: 'ATHLETIC', bg: '#f2f0e8', fg: '#14181c', accent: '#e2542c' },
  { name: 'HELIODYNE', tag: 'CLEAN POWER', bg: '#123222', fg: '#e9f7ee', accent: '#8ce07a' },
  { name: 'PORTSIDE', tag: 'COFFEE ROASTERS', bg: '#2b1a12', fg: '#f6e9d8', accent: '#d99a3f' },
  { name: 'VANTA', tag: 'MOTORS', bg: '#101012', fg: '#ffffff', accent: '#ff3b30' },
  { name: 'KESTREL AIR', tag: 'FLY THE COAST', bg: '#0d2340', fg: '#eaf2ff', accent: '#ffd23f' },
  { name: 'OBSIDIAN', tag: 'BANK', bg: '#1c1f26', fg: '#e8ecf2', accent: '#c9a227' },
  { name: 'FLATLINE', tag: 'ENERGY', bg: '#2a0f3a', fg: '#f5e9ff', accent: '#b14bff' },
];

function bakeAdStrip(ctx: Ctx): THREE.CanvasTexture {
  const W = 4096, H = 128;
  const rnd = ctx.rand.fork(0x1ed);
  return canvasTexture(W, H, (c) => {
    const pw = W / BRANDS.length;
    for (let i = 0; i < BRANDS.length; i++) {
      const b = BRANDS[i];
      const x = i * pw;
      c.save();
      c.beginPath(); c.rect(x, 0, pw, H); c.clip();
      c.fillStyle = b.bg; c.fillRect(x, 0, pw, H);

      // A diagonal accent wash so panels are not flat colour.
      const grad = c.createLinearGradient(x, 0, x + pw, H);
      grad.addColorStop(0, 'rgba(255,255,255,0.00)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.07)');
      grad.addColorStop(1, 'rgba(0,0,0,0.22)');
      c.fillStyle = grad; c.fillRect(x, 0, pw, H);

      c.fillStyle = b.accent;
      c.globalAlpha = 0.85;
      c.beginPath();
      c.moveTo(x + pw * 0.70, 0); c.lineTo(x + pw, 0);
      c.lineTo(x + pw, H); c.lineTo(x + pw * 0.60, H);
      c.closePath(); c.fill();
      c.globalAlpha = 1;

      // Wordmark
      c.fillStyle = b.fg;
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.font = '800 62px "Helvetica Neue", Helvetica, Arial, sans-serif';
      c.fillText(b.name, x + 40, H * 0.42);
      c.fillStyle = b.accent;
      c.font = '600 26px "Helvetica Neue", Helvetica, Arial, sans-serif';
      c.fillText(b.tag, x + 42, H * 0.74);

      // A tiny procedural glyph mark inside the accent block.
      c.save();
      c.translate(x + pw * 0.845, H * 0.5);
      c.strokeStyle = b.bg; c.lineWidth = 7; c.lineCap = 'round';
      const spokes = 3 + Math.floor(rnd.next() * 4);
      for (let s = 0; s < spokes; s++) {
        const a = (s / spokes) * Math.PI * 2 + i;
        c.beginPath();
        c.moveTo(Math.cos(a) * 12, Math.sin(a) * 12);
        c.lineTo(Math.cos(a) * 34, Math.sin(a) * 34);
        c.stroke();
      }
      c.beginPath(); c.arc(0, 0, 9, 0, Math.PI * 2); c.fill();
      c.restore();
      c.restore();
    }
  }, { name: 'led-ads', wrap: THREE.RepeatWrapping, anisotropy: 8 });
}

/* --------------------------------------------------------- jumbotron feed */

function drawJumbotron(c: CanvasRenderingContext2D, W: number, H: number, time: number): void {
  c.fillStyle = '#04070d';
  c.fillRect(0, 0, W, H);

  // Backdrop: soft radial wash + faint field diagram.
  const rg = c.createRadialGradient(W * 0.5, H * 0.42, 40, W * 0.5, H * 0.5, W * 0.7);
  rg.addColorStop(0, '#123a5c');
  rg.addColorStop(1, '#050a12');
  c.fillStyle = rg; c.fillRect(0, 0, W, H);

  c.strokeStyle = 'rgba(120,190,255,0.13)';
  c.lineWidth = 3;
  for (let i = 0; i <= 10; i++) {
    c.beginPath(); c.moveTo((i / 10) * W, 0); c.lineTo((i / 10) * W, H); c.stroke();
  }

  // Header bar
  c.fillStyle = '#0a1626';
  c.fillRect(0, 0, W, 92);
  c.fillStyle = '#d9a441';
  c.fillRect(0, 88, W, 5);
  c.fillStyle = '#eef4f9';
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.font = '800 50px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillText('ULTIMATE', 34, 46);
  c.font = '600 26px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillStyle = '#7fa6c6';
  c.fillText('CHAMPIONSHIP SERIES  ·  MATCH 4', 260, 48);

  // Score block
  const home = 11 + Math.floor(time / 41) % 4;
  const away = 9 + Math.floor(time / 57) % 4;
  const block = (x: number, name: string, col: string, score: number, align: CanvasTextAlign) => {
    c.fillStyle = col;
    c.fillRect(x - (align === 'right' ? 330 : 0), 150, 330, 12);
    c.fillStyle = '#f4f8fb';
    c.textAlign = align;
    c.font = '800 74px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillText(name, x, 216);
    c.font = '900 168px "Helvetica Neue", Helvetica, Arial, sans-serif';
    c.fillText(String(score), x, 356);
  };
  block(64, 'RIPTIDE', '#1d5c86', home, 'left');
  block(W - 64, 'CASCADE', '#c2452e', away, 'right');

  // Clock
  const total = Math.max(0, 900 - Math.floor(time * 3) % 900);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  c.textAlign = 'center';
  c.fillStyle = '#0b1523';
  c.fillRect(W / 2 - 140, 150, 280, 190);
  c.strokeStyle = '#d9a441'; c.lineWidth = 4;
  c.strokeRect(W / 2 - 140, 150, 280, 190);
  c.fillStyle = '#8fb6d6';
  c.font = '700 26px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillText('POINT 21  ·  CAP', W / 2, 180);
  c.fillStyle = '#f6fbff';
  c.font = '900 92px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillText(`${mm}:${ss}`, W / 2, 260);
  c.fillStyle = '#d9a441';
  c.font = '700 30px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillText('OFFENCE  ▸  RIPTIDE', W / 2, 318);

  // Live waveform strip — reads as motion without needing video.
  c.save();
  c.beginPath(); c.rect(40, 396, W - 80, 96); c.clip();
  c.fillStyle = '#08111d'; c.fillRect(40, 396, W - 80, 96);
  c.strokeStyle = '#37c8ff'; c.lineWidth = 4;
  c.beginPath();
  for (let x = 0; x <= W - 80; x += 8) {
    const u = x / (W - 80);
    const y = 444 + Math.sin(u * 22 + time * 2.4) * 26 * Math.sin(u * 3.1 + time * 0.7)
      + Math.sin(u * 61 - time * 3.9) * 7;
    if (x === 0) c.moveTo(40 + x, y); else c.lineTo(40 + x, y);
  }
  c.stroke();
  c.restore();

  // Sponsor footer
  c.fillStyle = '#0a1424';
  c.fillRect(0, H - 76, W, 76);
  const b = BRANDS[Math.floor(time / 7) % BRANDS.length];
  c.fillStyle = b.accent;
  c.fillRect(0, H - 76, 14, 76);
  c.textAlign = 'left';
  c.fillStyle = '#e9f1f7';
  c.font = '800 44px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.fillText(b.name, 40, H - 36);
  c.fillStyle = '#7fa6c6';
  c.font = '600 24px "Helvetica Neue", Helvetica, Arial, sans-serif';
  c.textAlign = 'right';
  c.fillText(b.tag, W - 40, H - 34);
}
