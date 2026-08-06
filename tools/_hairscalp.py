#!/usr/bin/env python3
"""Where the bright scalp is, and how connected it is.

  python3 tools/_hairscalp.py shots/hairR8/base-s0

Section 4.7's third fringe clause — "no scalp pixel ABOVE the visible hairline
brighter than face mean" — is the one number _haircheck.py reports as a bare
count.  A count cannot tell a 400 px notch from 400 px of salt spread along the
whole boundary, and those two want opposite fixes.  This prints the connected
components of the offending set and writes an overlay so it can be looked at.
"""
import sys
import numpy as np
from PIL import Image

D = sys.argv[1].rstrip('/')
SHOT = 'endzone' if '--endzone' in sys.argv else 'closeup'


def rd(p):
    return np.asarray(Image.open(f'{D}/{p}').convert('RGB')).astype(np.float64) / 255.0


full = rd(f'{SHOT}.png')
hairp = rd(f'{SHOT}_hair.png')
shellp = rd(f'{SHOT}_shell.png')
skinp = rd(f'{SHOT}_skin.png')
L = full @ np.array([0.2126, 0.7152, 0.0722])
H, W = L.shape


def mask(a, b, t=0.047):
    return np.abs(a - b).sum(2) > t


hair, shell, skin = mask(hairp, full), mask(shellp, full), mask(skinp, full)
eroded = shell & ~hair

ys, xs = np.nonzero(hair)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
face = skin.copy()
face[:, :x0 - 40] = False
face[:, x1 + 41:] = False
face[:y0] = False
face[y1 + 260:] = False
faceMean = float(L[face].mean())

scalp = eroded & skin
bright = scalp & (L > faceMean)


def comps(m):
    lab = np.zeros(m.shape, np.int32)
    n = 0
    for y0_, x0_ in zip(*np.nonzero(m)):
        if lab[y0_, x0_]:
            continue
        n += 1
        st = [(y0_, x0_)]
        lab[y0_, x0_] = n
        while st:
            y, x = st.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < m.shape[0] and 0 <= xx < m.shape[1] and m[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = n
                        st.append((yy, xx))
    return lab, n


lab, n = comps(bright)
sizes = []
for i in range(1, n + 1):
    m = lab == i
    yy, xx = np.nonzero(m)
    sizes.append((int(m.sum()), int(xx.max() - xx.min() + 1), int(yy.max() - yy.min() + 1),
                  int(xx.min()), int(yy.min()), round(float(L[m].max()), 3)))
sizes.sort(reverse=True)
print(f'faceMean={faceMean:.4f}  scalpPx={int(scalp.sum())}  brightPx={int(bright.sum())} '
      f' comps={n}')
print('  top comps (px, wPx, hPx, x, y, maxL):')
for s in sizes[:12]:
    print('   ', s)
widest = max((s[1] for s in sizes), default=0)
print(f'  widest bright component = {widest} px across')

# overlay: green = eroded-and-dark, red = eroded-and-brighter-than-face
ov = (full * 255).astype(np.uint8).copy()
ov[scalp & ~bright] = (0, 220, 0)
ov[bright] = (255, 0, 0)
Image.fromarray(ov[max(0, y0 - 30):y1 + 200, max(0, x0 - 60):x1 + 60]).save(f'{D}/_scalp_overlay.png')
print(f'  wrote {D}/_scalp_overlay.png')
