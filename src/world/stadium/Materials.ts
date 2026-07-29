import * as THREE from 'three';
import { bake, heightField, heightToNormal, linearColor, canvasTexture } from '../../util/Tex';
import { fbm2, worley2, ridged2, valueNoise2, clamp, smoothstep } from '../../util/Noise';
import type { Ctx } from '../../core/Ctx';
import { CLUB } from './Layout';

/**
 * Every stadium surface gets albedo variation, relief and spatially varying
 * roughness — a flat MeshStandardMaterial reads as a prototype from 40 m away
 * just as fast as it does from 2 m. Textures are tiled in *world* units (the
 * geometry writes metre-scaled UVs), so one 512² concrete set covers the whole
 * bowl without visible repeats at broadcast distance.
 */
export class StadiumMaterials {
  concrete!: THREE.MeshStandardMaterial;
  concreteDark!: THREE.MeshStandardMaterial;
  steel!: THREE.MeshStandardMaterial;
  steelDark!: THREE.MeshStandardMaterial;
  plastic!: THREE.MeshStandardMaterial;
  seat!: THREE.MeshStandardMaterial;
  paint!: THREE.MeshStandardMaterial;
  fabric!: THREE.MeshStandardMaterial;
  rubber!: THREE.MeshStandardMaterial;
  tarmac!: THREE.MeshStandardMaterial;
  roofDeck!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshStandardMaterial;
  foliage!: THREE.MeshStandardMaterial;
  signage!: THREE.MeshStandardMaterial;
  seatMapTex!: THREE.CanvasTexture;

  private disposables: Array<{ dispose(): void }> = [];

  build(ctx: Ctx): void {
    const aniso = ctx.quality.anisotropy;
    const S = ctx.quality.tier === 'low' ? 256 : 512;

    /* ------------------------------------------------------------ concrete */
    const cH = heightField(S, (u, v) => {
      const big = fbm2(u * 6, v * 6, { octaves: 4, seed: 11 }) * 0.5;
      const pits = worley2(u * 34, v * 34, 3).f1;
      const agg = 1 - smoothstep(0.0, 0.24, pits);
      const grit = valueNoise2(u * 210, v * 210, 5) * 0.16;
      const form = smoothstep(0.48, 0.5, Math.abs(((v * 4) % 1) - 0.5)) * 0.1;
      return big * 0.5 + agg * 0.32 + grit - form;
    });
    const cN = heightToNormal(cH, S, S, 1.35, { anisotropy: aniso });
    const cA = bake((x, y, u, v, out, i) => {
      const h = cH[y * S + x];
      const stain = clamp(fbm2(u * 3.1 + 9, v * 3.1, { octaves: 5, seed: 31 }) * 0.5 + 0.5, 0, 1);
      const streak = clamp(ridged2(u * 2.0, v * 22.0, { octaves: 3, seed: 77 }), 0, 1);
      let l = 0.60 + h * 0.30 - stain * 0.16 - streak * 0.10;
      l = clamp(l, 0.12, 0.92);
      const warm = 1 + (stain - 0.5) * 0.06;
      out[i] = 255 * l * warm * 0.99;
      out[i + 1] = 255 * l * 0.985;
      out[i + 2] = 255 * l * 0.955 * (1 - streak * 0.05);
      out[i + 3] = 255;
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'concrete-a' });
    const cR = bake((x, y, u, v, out, i) => {
      const h = cH[y * S + x];
      const wet = clamp(fbm2(u * 4.4, v * 4.4, { octaves: 3, seed: 5 }) * 0.5 + 0.5, 0, 1);
      const r = clamp(0.93 - h * 0.14 - wet * 0.10, 0.42, 1);
      out[i] = 255; out[i + 1] = 255 * r; out[i + 2] = 0; out[i + 3] = 255;
    }, { size: S, anisotropy: aniso, name: 'concrete-r' });
    this.disposables.push(cA, cN, cR);

    this.concrete = new THREE.MeshStandardMaterial({
      color: linearColor(CLUB.concrete), map: cA, normalMap: cN, roughnessMap: cR,
      normalScale: new THREE.Vector2(0.85, 0.85), roughness: 1.0, metalness: 0.0,
      vertexColors: true, name: 'concrete',
    });
    this.concreteDark = this.concrete.clone();
    this.concreteDark.color = linearColor(0x6d6a63);
    this.concreteDark.side = THREE.DoubleSide;   // vom interiors are seen from both sides
    this.concreteDark.name = 'concrete-dark';

    /* --------------------------------------------------------------- steel */
    const sH = heightField(256, (u, v) => {
      const brush = valueNoise2(u * 340, v * 12, 21) * 0.4;
      const dent = fbm2(u * 12, v * 12, { octaves: 3, seed: 3 }) * 0.3;
      const bolt = 1 - smoothstep(0.0, 0.09, worley2(u * 9, v * 9, 41).f1);
      return brush + dent + bolt * 0.7;
    });
    const sN = heightToNormal(sH, 256, 256, 1.0, { anisotropy: aniso });
    const sA = bake((x, y, u, v, out, i) => {
      const h = sH[y * 256 + x];
      const grime = clamp(fbm2(u * 5, v * 5, { octaves: 4, seed: 61 }) * 0.5 + 0.5, 0, 1);
      const rust = Math.max(0, ridged2(u * 7, v * 7, { octaves: 4, seed: 91 }) - 0.62) * 2.4;
      const l = clamp(0.78 + h * 0.16 - grime * 0.20, 0.2, 1);
      out[i] = 255 * clamp(l + rust * 0.25, 0, 1);
      out[i + 1] = 255 * clamp(l - rust * 0.12, 0, 1);
      out[i + 2] = 255 * clamp(l - rust * 0.22, 0, 1);
      out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'steel-a' });
    const sR = bake((x, y, u, v, out, i) => {
      const grime = clamp(fbm2(u * 5, v * 5, { octaves: 4, seed: 61 }) * 0.5 + 0.5, 0, 1);
      out[i] = 255; out[i + 1] = 255 * clamp(0.38 + grime * 0.36, 0.2, 0.95);
      out[i + 2] = 255 * 0.85; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'steel-r' });
    this.disposables.push(sA, sN, sR);

    this.steel = new THREE.MeshStandardMaterial({
      color: linearColor(CLUB.steel), map: sA, normalMap: sN, roughnessMap: sR, metalnessMap: sR,
      normalScale: new THREE.Vector2(0.7, 0.7), roughness: 0.55, metalness: 0.85,
      vertexColors: true, name: 'steel',
    });
    this.steelDark = this.steel.clone();
    this.steelDark.color = linearColor(0x4a4f55);
    this.steelDark.metalness = 0.8;
    this.steelDark.name = 'steel-dark';

    this.paint = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: sA, normalMap: sN, roughnessMap: sR,
      normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.45, metalness: 0.05,
      vertexColors: true, name: 'paint',
    });

    /* ------------------------------------------------------------- plastic */
    const pH = heightField(256, (u, v) => {
      const ribs = Math.abs(((v * 26) % 1) - 0.5);
      const rib = smoothstep(0.42, 0.5, ribs) * 0.55;
      const grain = valueNoise2(u * 190, v * 190, 13) * 0.14;
      const scuff = Math.max(0, fbm2(u * 20, v * 20, { octaves: 3, seed: 8 })) * 0.12;
      return rib + grain + scuff;
    });
    const pN = heightToNormal(pH, 256, 256, 1.15, { anisotropy: aniso });
    const pR = bake((x, y, u, v, out, i) => {
      const wear = clamp(fbm2(u * 9, v * 9, { octaves: 4, seed: 44 }) * 0.5 + 0.5, 0, 1);
      out[i] = 255; out[i + 1] = 255 * clamp(0.34 + wear * 0.42, 0.22, 0.92); out[i + 2] = 0; out[i + 3] = 255;
    }, { size: 256, anisotropy: aniso, name: 'plastic-r' });
    const pA = bake((x, y, u, v, out, i) => {
      const h = pH[y * 256 + x];
      const dirt = clamp(fbm2(u * 7 + 3, v * 7, { octaves: 4, seed: 19 }) * 0.5 + 0.5, 0, 1);
      const l = clamp(0.86 + h * 0.16 - dirt * 0.20, 0.35, 1);
      out[i] = 255 * l; out[i + 1] = 255 * l; out[i + 2] = 255 * l * 0.99; out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'plastic-a' });
    this.disposables.push(pN, pR, pA);

    this.plastic = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: pA, normalMap: pN, roughnessMap: pR,
      normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.6, metalness: 0.0,
      vertexColors: true, name: 'plastic',
    });
    // Seats are instanced: vertex colour carries the moulded-in AO, and the
    // per-instance colour carries the seat map (team colours + lettering).
    this.seat = this.plastic.clone();
    this.seat.name = 'seat';

    /* -------------------------------------------------------------- fabric */
    const fH = heightField(256, (u, v) => {
      const warp = Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5;
      const weft = Math.sin(v * Math.PI * 2 * 64) * 0.5 + 0.5;
      return warp * 0.5 + weft * 0.5 + valueNoise2(u * 120, v * 120, 7) * 0.2;
    });
    const fN = heightToNormal(fH, 256, 256, 0.85, { anisotropy: aniso });
    this.disposables.push(fN);
    this.fabric = new THREE.MeshStandardMaterial({
      color: 0xffffff, normalMap: fN, normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.88, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide, name: 'fabric',
    });

    /* -------------------------------------------------------------- rubber */
    this.rubber = new THREE.MeshStandardMaterial({
      color: 0x1a1a1c, map: pA, normalMap: pN, normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.94, metalness: 0.0, vertexColors: true, name: 'rubber',
    });

    /* -------------------------------------------------------------- tarmac */
    const tH = heightField(S, (u, v) => {
      const grain = worley2(u * 90, v * 90, 17).f1;
      return grain * 0.5 + valueNoise2(u * 240, v * 240, 23) * 0.3;
    });
    const tN = heightToNormal(tH, S, S, 1.5, { anisotropy: aniso });
    const tA = bake((x, y, u, v, out, i) => {
      const h = tH[y * S + x];
      const patch = clamp(fbm2(u * 3, v * 3, { octaves: 4, seed: 55 }) * 0.5 + 0.5, 0, 1);
      const l = clamp(0.20 + h * 0.14 + patch * 0.10, 0.06, 0.5);
      out[i] = 255 * l; out[i + 1] = 255 * l * 1.01; out[i + 2] = 255 * l * 1.05; out[i + 3] = 255;
    }, { size: S, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'tarmac-a' });
    this.disposables.push(tN, tA);
    this.tarmac = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: tA, normalMap: tN, roughness: 0.95, metalness: 0,
      vertexColors: true, name: 'tarmac',
    });

    /* ----------------------------------------------------------- roof deck */
    const rH = heightField(256, (u, v) => {
      const seam = Math.abs(((u * 16) % 1) - 0.5);
      const rib = smoothstep(0.46, 0.5, seam) * 1.0;
      const pan = Math.sin(u * Math.PI * 2 * 16) * 0.06;
      return rib + pan + valueNoise2(u * 120, v * 120, 3) * 0.1;
    });
    const rN = heightToNormal(rH, 256, 256, 2.4, { anisotropy: aniso });
    const rA = bake((x, y, u, v, out, i) => {
      const streak = clamp(ridged2(u * 3, v * 30, { octaves: 3, seed: 71 }), 0, 1);
      const l = clamp(0.62 - streak * 0.18 + rH[y * 256 + x] * 0.08, 0.15, 0.9);
      out[i] = 255 * l; out[i + 1] = 255 * l * 1.005; out[i + 2] = 255 * l * 1.02; out[i + 3] = 255;
    }, { size: 256, colorSpace: THREE.SRGBColorSpace, anisotropy: aniso, name: 'roof-a' });
    this.disposables.push(rN, rA);
    this.roofDeck = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: rA, normalMap: rN, normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.62, metalness: 0.45, vertexColors: true, name: 'roof-deck',
    });

    /* --------------------------------------------------------------- misc */
    this.glass = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.22, metalness: 0.55, vertexColors: true, name: 'exterior',
    });
    this.foliage = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.92, metalness: 0.0, vertexColors: true,
      flatShading: true, name: 'foliage',
    });
    this.signage = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.55, metalness: 0.0, vertexColors: true,
      alphaTest: 0.42, side: THREE.DoubleSide, name: 'signage',
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ----------------------------------------------------------- seat colouring */

/**
 * The seat colour map. Horizontal axis is the bowl's base parameter t (0..1
 * around the plan), vertical axis is the row. Everything the bowl "spells out"
 * in contrasting seats is painted here and sampled per seat, which is exactly
 * how a real venue lays out its lettering.
 */
export function bakeSeatMap(): THREE.CanvasTexture {
  const W = 2048, H = 256;
  return canvasTexture(W, H, (c) => {
    const px = (t: number) => t * W;
    c.fillStyle = '#11314f';
    c.fillRect(0, 0, W, H);

    // Row-banding: lighter band across the upper third, darker kerb at row 0.
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(9,26,44,1)');
    grad.addColorStop(0.42, 'rgba(17,49,79,1)');
    grad.addColorStop(0.62, 'rgba(29,92,134,1)');
    grad.addColorStop(0.68, 'rgba(17,49,79,1)');
    grad.addColorStop(1, 'rgba(21,63,97,1)');
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);

    // Section alternation — every other section a touch darker.
    c.globalAlpha = 0.16;
    for (let i = 0; i < 28; i += 2) {
      c.fillStyle = '#000000';
      c.fillRect((i / 28) * W, 0, W / 28, H);
    }
    c.globalAlpha = 1;

    // Base parameter ranges (must mirror Layout.SEGS ordering).
    const sxL = 24 - 12, szL = 55 - 12;
    const segLens = [2 * szL, 12 * Math.PI / 2, 2 * sxL, 12 * Math.PI / 2,
      2 * szL, 12 * Math.PI / 2, 2 * sxL, 12 * Math.PI / 2];
    const P = segLens.reduce((a, b) => a + b, 0);
    const t0: number[] = []; let acc = 0;
    for (const l of segLens) { t0.push(acc / P); acc += l; }
    const tEnd = (i: number) => t0[i] + segLens[i] / P;

    const drawText = (seg: number, text: string, yTop: number, yBot: number, fill: string, weight = 900) => {
      const a = px(t0[seg]) + 26, b = px(tEnd(seg)) - 26;
      const w = b - a, h = (yBot - yTop) * H;
      c.save();
      c.translate(a, yTop * H);
      c.fillStyle = fill;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `${weight} 100px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      const m = c.measureText(text);
      const s = Math.min(w / (m.width + 1), h / 82);
      c.translate(w / 2, h / 2);
      c.scale(s, s);
      c.fillText(text, 0, 0);
      c.restore();
    };

    // Seat lettering. Rows run bottom (row 0) → top of the canvas is the back
    // of the bowl, so lettering sits in the mid-to-upper rows where it reads.
    drawText(0, 'U L T I M A T E', 0.30, 0.56, '#e9edf0');
    drawText(4, 'R I P T I D E', 0.30, 0.56, '#e9edf0');
    drawText(2, 'EST 2019', 0.34, 0.52, '#d9a441');
    drawText(6, 'RIPTIDE', 0.32, 0.54, '#d9a441');

    // Chevron flashes in the corners.
    for (const seg of [1, 3, 5, 7]) {
      const a = px(t0[seg]), b = px(tEnd(seg));
      c.save();
      c.beginPath();
      c.rect(a, 0.60 * H, b - a, 0.14 * H);
      c.clip();
      c.strokeStyle = '#d9a441';
      c.lineWidth = 7;
      for (let x = a - 40; x < b + 40; x += 34) {
        c.beginPath();
        c.moveTo(x, 0.60 * H);
        c.lineTo(x + 17, 0.74 * H);
        c.lineTo(x + 34, 0.60 * H);
        c.stroke();
      }
      c.restore();
    }

    // A pale top band (the "wrap") plus sprinkled gold seats for break-up.
    c.fillStyle = '#c9d3da';
    c.fillRect(0, 0.90 * H, W, 0.045 * H);
    c.fillStyle = 'rgba(217,164,65,0.85)';
    for (let i = 0; i < 900; i++) {
      const h = (i * 2654435761) >>> 0;
      const x = (h % W), y = ((h >>> 11) % H);
      if (y > 0.86 * H || y < 0.1 * H) continue;
      c.fillRect(x, y, 3, 3);
    }
  }, { name: 'seat-map', wrap: THREE.RepeatWrapping, anisotropy: 4 });
}

/** Reads a colour out of the seat map. `t` 0..1 around the bowl, `rt` 0..1 up. */
export class SeatMapSampler {
  private data: ImageData;
  private w: number;
  private h: number;
  constructor() {
    const W = 512, H = 128;
    const tex = bakeSeatMap();
    const src = tex.image as HTMLCanvasElement;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    c.drawImage(src, 0, 0, W, H);
    this.data = c.getImageData(0, 0, W, H);
    this.w = W; this.h = H;
    tex.dispose();
  }
  sample(t: number, rt: number, out: THREE.Color): THREE.Color {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(t * this.w)));
    const y = Math.min(this.h - 1, Math.max(0, Math.floor((1 - rt) * this.h)));
    const i = (y * this.w + x) * 4;
    out.setRGB(
      this.data.data[i] / 255, this.data.data[i + 1] / 255, this.data.data[i + 2] / 255,
      THREE.SRGBColorSpace,
    );
    return out;
  }
}
