#!/usr/bin/env python3
"""Section 4.7's macro-value and hairline-step clauses, split LIT vs SHADOW.

  python3 tools/_hairside.py shots/hairR8/base-s0

_haircheck.py reports both as one pooled number over the whole cap, and pooled
is the wrong unit for a head lit from one side: the shadow half of the cap can
carry the whole macro-value pass while the lit half renders as a featureless
dome, and the pooled figure still reads 0.93.  The eye only ever looks at the
lit half.
"""
import sys
import numpy as np
from PIL import Image

D = sys.argv[1].rstrip('/')
SHOT = 'closeup'


def rd(p):
    return np.asarray(Image.open(f'{D}/{p}').convert('RGB')).astype(np.float64) / 255.0


full, hairp, skinp = rd(f'{SHOT}.png'), rd(f'{SHOT}_hair.png'), rd(f'{SHOT}_skin.png')
L = full @ np.array([0.2126, 0.7152, 0.0722])
mk = lambda a, b: np.abs(a - b).sum(2) > 0.047
hair, skin = mk(hairp, full), mk(skinp, full)
ys, xs = np.nonzero(hair)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
xm = int((x0 + x1) / 2)

# which half is lit: compare forehead means
hairline = {}
for x in range(x0, x1 + 1):
    ch = np.nonzero(hair[:, x])[0]
    if len(ch):
        hairline[x] = ch.max()

K = 13
# One pass over the whole cap; each 40 px window is attributed to the half its
# CENTRE falls in.  Splitting the rows first leaves each half too short for a
# 61 px detrend, which silently returns n=0 rather than a number.
sideDC = {'shadow': [], 'lit': []}
for y in range(y0, y1 + 1):
    row = hair[y]
    if row.sum() < 60:
        continue
    xs_ = np.nonzero(row)[0]
    a, b = xs_.min(), xs_.max()
    if b - a + 1 < 100 or row[a:b + 1].mean() < 0.9:
        continue
    seg = L[y, a:b + 1]
    trend = np.convolve(seg, np.ones(61) / 61, mode='same')
    det, base = (seg - trend)[30:-30], trend[30:-30]
    if len(det) <= 55:
        continue
    ds = np.convolve(det, np.ones(K) / K, mode='valid')
    bs = np.convolve(base, np.ones(K) / K, mode='valid')
    for i in range(0, len(ds) - 40, 8):
        w, bw = ds[i:i + 40], bs[i:i + 40]
        c = (w.max() - w.min()) / max(1e-6, bw.mean())
        cx = a + 30 + i + 20 + K // 2
        sideDC['lit' if cx >= xm else 'shadow'].append(c)

# A SCANLINE DOWN THE FOREHEAD, not down the temple.  Where the cap's boundary
# runs near-vertical (the silhouette at the sides of the head) an 8 px box above
# it is half background and the "step" it reports is noise: on the delivered
# frame that alone produced a p95 of 2.49 against a median of 0.84.  Keep only
# columns whose boundary is flat-ish AND that have a real run of skin under it.
cols = sorted(hairline)
hb_arr = np.array([hairline[x] for x in cols], float)
slope = np.abs(np.gradient(hb_arr)) if len(cols) > 2 else np.zeros(len(cols))
good = {}
for i, x in enumerate(cols):
    hb = hairline[x]
    if slope[i] > 1.5:
        continue
    if skin[hb + 2:hb + 24, x].sum() < 18:      # forehead, not sky or ear
        continue
    good[x] = hb

for nm, lo, hi in (('shadow', x0, xm), ('lit', xm, x1 + 1)):
    dc = sideDC[nm]
    dwins = len(dc)
    dpass = sum(1 for c in dc if c >= 0.20)
    # hairline step on this half
    r = []
    for x, hb in good.items():
        if not (lo <= x < hi):
            continue
        up, dn = L[max(0, hb - 9):hb - 1, x], L[hb + 3:hb + 11, x]
        if len(up) and len(dn) and dn.mean() > 1e-4:
            r.append(up.mean() / dn.mean())
    r = np.array(r) if r else np.array([1.0])
    hm = hair.copy(); hm[:, :lo] = False; hm[:, hi:] = False
    print(f'{nm:7s} hairMeanL={L[hm].mean():.4f}  macroDetrendedPass={dpass/max(1,dwins):.3f} '
          f'(median {np.median(dc) if dc else 0:.3f}, n={dwins})  '
          f'step med={np.median(r):.3f} p05={np.percentile(r,5):.3f} p95={np.percentile(r,95):.3f} '
          f'over1.25={np.mean(r>1.25):.3f} under0.80={np.mean(r<0.80):.3f} '
          f'in[0.75,0.85]={np.mean((r>=0.75)&(r<=0.85)):.3f} step>=15%={np.mean(np.abs(r-1)>=0.15):.3f}')
