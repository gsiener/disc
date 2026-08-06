import { readPNG, px } from './_png.mjs';
const img = readPNG(process.argv[2]);
const srgb2lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function region(name, x0, y0, w, h) {
  let r = 0, g = 0, b = 0, n = 0; const L = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const [pr, pg, pb] = px(img, x, y);
    r += pr; g += pg; b += pb; n++;
    L.push((0.2126 * pr + 0.7152 * pg + 0.0722 * pb) / 255);
  }
  L.sort((a, b) => a - b);
  const enc = [r / n / 255, g / n / 255, b / n / 255];
  const hexv = enc.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  // HSV sat
  const mx = Math.max(...enc), mn = Math.min(...enc);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  console.log(`${name.padEnd(16)} mean=#${hexv} luma=${(L[Math.floor(n/2)]).toFixed(3)} p05=${L[Math.floor(n*0.05)].toFixed(3)} p95=${L[Math.floor(n*0.95)].toFixed(3)} sat=${sat.toFixed(2)}`);
  return { enc, med: L[Math.floor(n/2)] };
}
const args = process.argv.slice(3);
for (let i = 0; i < args.length; i += 5) region(args[i], +args[i+1], +args[i+2], +args[i+3], +args[i+4]);
