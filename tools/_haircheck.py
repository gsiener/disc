#!/usr/bin/env python3
"""Section 4.7 + endzone-hairline checker, counted off the plate dump.

  python3 tools/_haircheck.py shots/hairmeas/base-s0            # closeup
  python3 tools/_haircheck.py shots/hairmeas/base-s0 --endzone

Plates come from tools/_hairmeas.mjs.  Every number below is a ratio between
two masked regions, which is exactly what capture.mjs cannot give you.
"""
import sys, json
import numpy as np
from PIL import Image

D = sys.argv[1].rstrip('/')
EZ = '--endzone' in sys.argv
SHOT = 'endzone' if EZ else 'closeup'


def rd(p):
    return np.asarray(Image.open(f'{D}/{p}').convert('RGB')).astype(np.float64) / 255.0


full = rd(f'{SHOT}.png')
nohair = rd(f'{SHOT}_nohair.png')
hairp = rd(f'{SHOT}_hair.png')
shellp = rd(f'{SHOT}_shell.png')
skinp = rd(f'{SHOT}_skin.png')

L = full @ np.array([0.2126, 0.7152, 0.0722])
H, W = L.shape


def mask(a, b, t=0.047):
    return np.abs(a - b).sum(2) > t


# EVERY MASK IS DIFFED AGAINST THE SHIPPED FRAME, NEVER AGAINST `nohair`.
# The cap casts a shadow onto the brow and the upper cheek, so hiding it does
# not only remove hair pixels — it re-lights a band of face 80 px below the
# hairline, and `hair vs nohair` calls that band hair.  Measured, it put ~70
# bogus columns of "hair" across the eye socket and read their (unchanged)
# boundary as zero erosion depth, which is a 30 % error in the headline number.
# The emissive flag differs between plate and shipped frame; the shadow does
# not, because the depth material never saw the alpha patch.
hair = mask(hairp, full)
shell = mask(shellp, full)
skin = mask(skinp, full)
eroded = shell & ~hair

out = {'shot': SHOT, 'dir': D}


def comps(m):
    """Connected components (4-neighbour), iterative flood fill."""
    lab = np.zeros(m.shape, np.int32)
    n = 0
    ys, xs = np.nonzero(m)
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]:
            continue
        n += 1
        st = [(y0, x0)]
        lab[y0, x0] = n
        while st:
            y, x = st.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < m.shape[0] and 0 <= xx < m.shape[1] and m[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n
                    st.append((yy, xx))
    return lab, n


# ---------------------------------------------------------------- closeup
if not EZ:
    ys, xs = np.nonzero(hair)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    out['hairPx'] = int(hair.sum())
    out['shellPx'] = int(shell.sum())
    out['erodedPx'] = int(eroded.sum())
    out['bbox'] = [int(x0), int(x1), int(y0), int(y1)]

    # ---- fringe: per-column depth where the boundary has skin under it -----
    depths, cols = [], []
    hairline_y = {}
    for x in range(x0, x1 + 1):
        ch, cs = np.nonzero(hair[:, x])[0], np.nonzero(shell[:, x])[0]
        if len(ch) == 0 or len(cs) == 0:
            continue
        hb, sb = ch.max(), cs.max()
        # fringe column = skin immediately under the hair boundary
        lo, hi = hb + 1, min(H, hb + 26)
        if lo >= hi or skin[lo:hi, x].sum() < 8:
            continue
        cols.append(x)
        depths.append(sb - hb)
        hairline_y[x] = hb
    # DEPTH IS PERPENDICULAR TO THE BOUNDARY, NOT DOWN THE COLUMN.  At the two
    # silhouette edges of a cap the hairline runs nearly vertically, so a 5 px
    # cut shows up as a 26 px column drop and reports as a notch that is not
    # there.  Correcting by the local boundary slope is the difference between
    # "max 26 px" and "max 9 px" on the same frame.
    depths = np.array(depths, float)
    hb_arr = np.array([hairline_y[x] for x in cols], float)
    slope = np.gradient(hb_arr) if len(hb_arr) > 2 else np.zeros_like(hb_arr)
    perp = depths / np.sqrt(1.0 + slope * slope)
    out['fringePerp'] = {
        'p10': round(float(np.percentile(perp, 10)), 2) if len(perp) else None,
        'median': round(float(np.median(perp)), 2) if len(perp) else None,
        'p90': round(float(np.percentile(perp, 90)), 2) if len(perp) else None,
        'max': round(float(perp.max()), 2) if len(perp) else None,
        'fracInWindow_4_10': round(float(((perp >= 4) & (perp <= 10)).mean()), 3) if len(perp) else None,
        'fracZero': round(float((perp < 1).mean()), 3) if len(perp) else None,
    }
    over_p, run_p, worst_p = perp > 10, 0, 0
    for v in over_p:
        run_p = run_p + 1 if v else 0
        worst_p = max(worst_p, run_p)
    out['fringePerp']['widestOver10pxRun'] = int(worst_p)
    out['fringe'] = {
        'columns': len(depths),
        'min': int(depths.min()) if len(depths) else None,
        'p10': float(np.percentile(depths, 10)) if len(depths) else None,
        'median': float(np.median(depths)) if len(depths) else None,
        'p90': float(np.percentile(depths, 90)) if len(depths) else None,
        'max': int(depths.max()) if len(depths) else None,
        'fracInWindow_4_10': float(((depths >= 4) & (depths <= 10)).mean()) if len(depths) else None,
        'fracZero': float((depths == 0).mean()) if len(depths) else None,
    }
    # widest run of columns eroded deeper than the 10 px ceiling = the notch
    over, run, worst = depths > 10, 0, 0
    for v in over:
        run = run + 1 if v else 0
        worst = max(worst, run)
    out['fringe']['widestOver10pxRun'] = int(worst)

    # ---- face / forehead means -------------------------------------------
    face = skin.copy()
    face[:, :x0 - 40] = False
    face[:, x1 + 41:] = False
    face[:y0] = False
    face[y1 + 260:] = False
    faceMean = float(L[face].mean())
    out['faceMeanL'] = faceMean

    # forehead = skin within 55 px below the visible hairline, per column
    fh = np.zeros_like(skin)
    for x, hb in hairline_y.items():
        fh[hb + 2:hb + 57, x] = skin[hb + 2:hb + 57, x]
    xm = (x0 + x1) / 2
    sides = {}
    for nm, sel in (('left', lambda a: a[:, :int(xm)]), ('right', lambda a: a[:, int(xm):])):
        hs, fs = sel(hair), sel(fh)
        Ls = sel(L)
        if hs.sum() < 50 or fs.sum() < 50:
            sides[nm] = None
            continue
        hmn, fmn = float(Ls[hs].mean()), float(Ls[fs].mean())
        sides[nm] = {'hairMeanL': round(hmn, 4), 'foreheadMeanL': round(fmn, 4),
                     'ratio': round(hmn / fmn, 3), 'hairPx': int(hs.sum()), 'foreheadPx': int(fs.sum())}
    out['sides'] = sides
    out['foreheadMeanL'] = float(L[fh].mean()) if fh.sum() else None
    out['hairMeanL'] = float(L[hair].mean())
    out['hairOverForehead'] = round(out['hairMeanL'] / out['foreheadMeanL'], 3) if fh.sum() else None

    # ---- eroded scalp must never be brighter than face mean ---------------
    #
    # Restricted to eroded pixels the SKIN material now draws.  The rest of the
    # eroded set is the outer silhouette against the crowd bokeh, which is not
    # scalp and not what 4.7 is about.
    scalp = eroded & skin
    if scalp.sum():
        ev = L[scalp]
        out['erodedScalp'] = {'px': int(scalp.sum()), 'maxL': round(float(ev.max()), 4),
                              'meanL': round(float(ev.mean()), 4),
                              'pxOverFaceMean': int((ev > faceMean).sum())}
    else:
        out['erodedScalp'] = {'px': 0}

    # ---- macro value + striping, one pass over the cap's rows -------------
    #
    # Two readings of 4.7's macro clause.  `fracOver20pct` is the brief taken
    # literally — 40 px of raw luminance, which on a head lit from one side is
    # mostly the terminator sweeping through the window.  `detrendedFrac` takes
    # a 61 px moving average out first, so what is left is lock structure and
    # nothing else; that is the number the wig read actually depends on.
    #
    # STRIPING IS A PERIODICITY TEST, NOT A SMOOTHNESS TEST.  A high-passed row
    # of a smooth dome autocorrelates strongly at lag 2-3 simply because it is
    # smooth, so "ACF(2..5) > t" reports 55 % of a cap that has no stripes in
    # it at all.  Corduroy has a repeat, and a repeat shows up as an INTERIOR
    # local maximum of the ACF; a smooth ramp's ACF decays monotonically.
    K = 13                        # lock scale, 10-15 px
    wins = passes = dwins = dpasses = 0
    contrasts, dcontrasts = [], []
    striped_px, tot_px, lag_hist = 0, 0, {}
    for y in range(y0, y1 + 1):
        row = hair[y]
        if row.sum() < 60:
            continue
        xs_ = np.nonzero(row)[0]
        a, b = xs_.min(), xs_.max()
        if b - a + 1 < 60 or row[a:b + 1].mean() < 0.9:
            continue
        seg = L[y, a:b + 1]
        sm = np.convolve(seg, np.ones(K) / K, mode='valid')
        for i in range(0, len(sm) - 40, 8):
            w = sm[i:i + 40]
            c = (w.max() - w.min()) / max(1e-6, w.mean())
            contrasts.append(c)
            wins += 1
            passes += c >= 0.20
        # detrended: lock structure with the lighting ramp removed
        trend = np.convolve(seg, np.ones(61) / 61, mode='same')
        det = (seg - trend)[30:-30]
        base = trend[30:-30]
        if len(det) > 55:
            ds = np.convolve(det, np.ones(K) / K, mode='valid')
            bs = np.convolve(base, np.ones(K) / K, mode='valid')
            for i in range(0, len(ds) - 40, 8):
                w, bw = ds[i:i + 40], bs[i:i + 40]
                c = (w.max() - w.min()) / max(1e-6, bw.mean())
                dcontrasts.append(c)
                dwins += 1
                dpasses += c >= 0.20
        hp = (seg - np.convolve(seg, np.ones(15) / 15, mode='same'))[7:-7]
        if len(hp) < 40 or hp.std() < 1e-5:
            continue
        hp = hp - hp.mean()
        den = (hp * hp).sum()
        ac = [float((hp[:-l] * hp[l:]).sum() / den) for l in range(1, 16)]
        best = None
        for i in range(1, 9):                      # lags 2..9
            if ac[i] > ac[i - 1] and ac[i] > ac[i + 1] and ac[i] > 0.15:
                if best is None or ac[i] > ac[best - 1]:
                    best = i + 1
        tot_px += len(hp)
        if best is not None:
            lag_hist[best] = lag_hist.get(best, 0) + 1
            if best < 6:
                striped_px += len(hp)
    out['macroValue'] = {'windows': wins, 'fracOver20pct': round(passes / max(1, wins), 3),
                         'medianContrast': round(float(np.median(contrasts)), 4) if contrasts else None,
                         'detrendedWindows': dwins,
                         'detrendedFracOver20pct': round(dpasses / max(1, dwins), 3),
                         'detrendedMedian': round(float(np.median(dcontrasts)), 4) if dcontrasts else None}
    out['striping'] = {'capPx': tot_px, 'fracCapStripedUnder6px': round(striped_px / max(1, tot_px), 3),
                       'periodicPeakLagHistogram': dict(sorted(lag_hist.items()))}

    # ---- hair/skin boundary step (4.6 <=1.25x, and endzone wants >=15%) ---
    ratios = []
    for x, hb in hairline_y.items():
        up, dn = L[max(0, hb - 9):hb - 1, x], L[hb + 3:hb + 11, x]
        if len(up) and len(dn) and dn.mean() > 1e-4:
            ratios.append(up.mean() / dn.mean())
    if ratios:
        r = np.array(ratios)
        out['hairlineStep'] = {'medianRatio': round(float(np.median(r)), 3),
                               'p05': round(float(np.percentile(r, 5)), 3),
                               'p95': round(float(np.percentile(r, 95)), 3),
                               'fracOver1_25': round(float((r > 1.25).mean()), 3),
                               'fracUnder0_80': round(float((r < 0.80).mean()), 3),
                               'fracStepOver15pct': round(float((np.abs(r - 1) >= 0.15).mean()), 3)}

# ---------------------------------------------------------------- endzone
else:
    lab, n = comps(hair)
    heads = []
    for i in range(1, n + 1):
        m = lab == i
        if m.sum() < 25:
            continue
        ys, xs = np.nonzero(m)
        hpx = ys.max() - ys.min() + 1
        wpx = xs.max() - xs.min() + 1
        # head height ~ hair cap + face below it; use the skin run underneath
        cx = int(np.median(xs))
        col = np.nonzero(skin[:, cx])[0]
        below = col[col > ys.max()]
        faceH = 0
        if len(below):
            run = 1
            for k in range(1, len(below)):
                if below[k] == below[k - 1] + 1:
                    run += 1
                else:
                    break
            faceH = run
        headPx = hpx + faceH
        if headPx < 20:
            continue
        # scanline down the forehead midline: the hairline must be a >=15% step
        best = 0.0
        for x in range(max(0, cx - 6), min(W, cx + 7)):
            ch = np.nonzero(hair[:, x])[0]
            if not len(ch):
                continue
            hb = ch.max()
            up, dn = L[max(0, hb - 5):hb, x], L[hb + 2:hb + 8, x]
            if len(up) and len(dn) and dn.mean() > 1e-4:
                best = max(best, abs(up.mean() / dn.mean() - 1))
        fm = np.zeros_like(skin)
        fm[:, max(0, cx - wpx // 2):cx + wpx // 2] = skin[:, max(0, cx - wpx // 2):cx + wpx // 2]
        fm[:ys.min()] = False
        fm[ys.max() + headPx:] = False
        if fm.sum() < 20:
            continue
        fmean = float(L[fm].mean())
        heads.append({'cx': int(cx), 'headPx': int(headPx), 'hairPx': int(m.sum()),
                      'hairlineStep': round(best, 3),
                      'faceMeanL': round(fmean, 4),
                      'facePxOver1_4x': int((L[fm] > 1.4 * fmean).sum()),
                      'hairMeanL': round(float(L[m].mean()), 4),
                      'hairOverFace': round(float(L[m].mean()) / fmean, 3)})
    heads.sort(key=lambda h: -h['headPx'])
    out['heads'] = heads[:8]
    out['headsOver20px'] = len(heads)
    out['headsFailingStep'] = sum(1 for h in heads if h['hairlineStep'] < 0.15)

print(json.dumps(out, indent=1))
