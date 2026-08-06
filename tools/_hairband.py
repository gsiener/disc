#!/usr/bin/env python3
"""Hairline acceptance numbers, binned ALONG the boundary and split by term.

  node tools/_hairmeas.mjs closeup --abl --out shots/hairmeas/x
  python3 tools/_hairband.py shots/hairmeas/x

`_haircheck.py` pools the hairline into one distribution and `_hairside.py`
splits it lit vs shadow.  Both are still too coarse, and the way they are too
coarse costs a round: on seed 0 the shadow half reads "step median 0.59, wide",
which looks like one uniformly dark boundary and invites a global gain.  It is
not one boundary.  Binned by x, the SAME shadow half contains a temple at 1.22x
its forehead and a front at 0.51x — a 2.4x spread inside one half — and the two
are carried by different lighting paths, so no single scale closes them:

    x-band                 hair    fore    ratio | albedo  sheen   halo    lobes
    left temple  (32 col)  0.310   0.255   1.22  | 0.041   0.006   0.182   0.081
    front       (103 col)  0.113   0.224   0.51  | 0.074   0.005   0.018   0.017
    right of ctr (34 col)  0.394   0.402   0.98  | 0.091   0.002   0.015   0.286
    lit temple   (33 col)  0.557   0.723   0.77  | 0.066   0.003   0.038   0.451

The term columns are the ablation plates `--abl` shoots in the same run, so this
costs one capture and answers "which path do I have to move" rather than "by how
much is it wrong".  Ablations are optional; without them the ratios still print.

Columns whose boundary runs near-vertical are dropped (an 8 px box above a
vertical hairline is half background) and so are columns with no run of skin
under them, exactly as in `_hairside.py`.
"""
import sys
import os
import numpy as np
from PIL import Image

D = sys.argv[1].rstrip('/')
SHOT = 'endzone' if '--endzone' in sys.argv else 'closeup'
NBANDS = 4


def rd(p):
    return np.asarray(Image.open(f'{D}/{p}').convert('RGB')).astype(np.float64) / 255.0


def lum(im):
    return im @ np.array([0.2126, 0.7152, 0.0722])


full, hairp, skinp = rd(f'{SHOT}.png'), rd(f'{SHOT}_hair.png'), rd(f'{SHOT}_skin.png')
L = lum(full)
hair = np.abs(hairp - full).sum(2) > 0.047
skin = np.abs(skinp - full).sum(2) > 0.047

xs = np.nonzero(hair)[1]
x0, x1 = xs.min(), xs.max()
hb = {}
for x in range(x0, x1 + 1):
    ch = np.nonzero(hair[:, x])[0]
    if len(ch):
        hb[x] = ch.max()
cols = sorted(hb)
slope = np.abs(np.gradient(np.array([hb[x] for x in cols], float))) if len(cols) > 2 \
    else np.zeros(len(cols))
good = [x for i, x in enumerate(cols)
        if slope[i] <= 1.5 and skin[hb[x] + 2:hb[x] + 24, x].sum() >= 18]
if not good:
    print('no usable boundary columns')
    sys.exit(0)

plates = {n: lum(rd(f'{SHOT}{n}.png'))
          for n in ('', '_noalb', '_nosheen', '_noglow')
          if os.path.exists(f'{D}/{SHOT}{n}.png')}

edges = np.linspace(good[0], good[-1] + 1, NBANDS + 1)
hdr = f'{"x-band":>13s} {"n":>4s} {"hair":>7s} {"fore":>7s} {"ratio":>6s}'
if len(plates) > 1:
    hdr += f' | {"albedo":>7s} {"sheen":>7s} {"halo":>7s} {"lobes":>7s}'
print(f'{D}  {SHOT}')
print(hdr)
for b in range(NBANDS):
    gs = [x for x in good if edges[b] <= x < edges[b + 1]]
    if len(gs) < 4:
        continue
    band = np.zeros_like(hair)
    ref = np.zeros_like(hair)
    for x in gs:
        band[hb[x] - 9:hb[x] - 1, x] = True     # 8 px of hair above the hairline
        ref[hb[x] + 3:hb[x] + 11, x] = True     # 8 px of forehead below it
    band &= hair
    ref &= skin
    if band.sum() < 20 or ref.sum() < 20:
        continue
    h, f = float(L[band].mean()), float(L[ref].mean())
    row = f'{int(edges[b]):5d}-{int(edges[b+1]):<7d} {len(gs):4d} {h:7.3f} {f:7.3f} {h/f:6.3f}'
    if len(plates) > 1:
        parts = {k: h - float(v[band].mean()) for k, v in plates.items() if k}
        rest = h - sum(parts.values())
        row += (f' | {parts.get("_noalb", float("nan")):7.3f}'
                f' {parts.get("_nosheen", float("nan")):7.3f}'
                f' {parts.get("_noglow", float("nan")):7.3f} {rest:7.3f}')
    print(row)
print('  ratio is hair/forehead; section 4.6 wants 0.80-1.25, the endzone '
      'hairline wants a step of at least 15 %, so the target is 0.80-0.87.')
