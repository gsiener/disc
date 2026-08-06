# python3 tools/_eyecheck.py <shaded.png> <mask.png> [--endzone ez.png] [--overlay out.png]
#
# Section-4 checker for the eye directives in docs/face-direction.md, counted off
# the delivered PNGs and nothing else.
#
# TWO THINGS IN HERE ARE LOAD-BEARING AND BOTH HAVE BITTEN SOMEBODY.
#
# 1. LUMINANCE IS sRGB-ENCODED, NOT LINEAR. The brief's table says "Mean
#    luminance, sRGB 0-1" and its own worked example proves it: it quotes the
#    shadow cheek as "0.34 at RGB (109, 82, 72)", and 0.2126R+0.7152G+0.0722B on
#    those bytes/255 is 0.341 encoded and 0.099 linear. Every threshold in the
#    brief (1.3x, 0.85x, 0.45-0.65x) is a ratio in the encoded space, which is
#    also the space a painter squints in. tools/_eyelum.mjs gamma-DECODES before
#    it ratios, so its numbers are not the brief's numbers and are not
#    comparable: in linear space a 1.7x encoded ratio reads as ~3x.
#
# 2. THE THREE REGIONS COME FROM A MASK PASS, NOT FROM VALUE. Segmenting an eye
#    out of a shaded render by luminance is the measurement six rounds got
#    wrong: a black iris and a lash are one population, and an Otsu split puts
#    the boundary wherever the specular smear happens to be. So the stencils
#    come from a second capture taken with Eyes.ts's DEBUG_MASK armed, which
#    paints the regions flat. The tableau is frozen and deterministic, so that
#    frame is pixel-aligned with the shaded one. DEBUG_MASK ships 0; this is the
#    only thing it is for.
#
# The pupil is 2x2 px at this framing and post-processing blooms the iris over
# it, so it is NOT read off the hatch by colour. Iris and pupil are one filled
# blob ("not sclera"), which is exactly what section 4.3 asks for anyway, and
# the pupil is taken analytically as the inner disc of that blob at
# pupilR/irisR (~0.29, PlayerMaterial.ts).
import json
import sys
import numpy as np
from PIL import Image

def lum(img):
    """sRGB-ENCODED luminance, 0-1. See note 1 above before changing this."""
    a = img.astype(np.float64) / 255.0
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

# Hand-placed against a 7x zoom of shots/eyes-r9-base/closeup.png at 1600x900,
# --q ultra. L / R are VIEWER left and right; the viewer-left side of this face
# is the shadow side, which is why cheeks are sampled per-eye and never pooled.
BOX = {
    'eyeL':   (826, 238, 902, 280),   # search window: aperture plus surrounding lid
    'eyeR':   (926, 236, 992, 278),
    # UPPER cheek: the skin the brief ratios against is the band immediately
    # below the lower lid, not the mid-cheek. This face is patched hard enough
    # that a box 20 px lower lands on a different lobe and moves every ratio.
    'cheekL': (838, 280, 890, 298),
    'cheekR': (938, 277, 984, 293),
    'orbitL': (826, 224, 902, 278),   # brow top to lower lid, canthus to canthus
    'orbitR': (930, 222, 990, 276),
}
# Endzone heads, hand-placed off shots/eyes-r9-k/endzone.png at 1600x900.
# Skin only — hair and background are other agents' acceptance tests, and a box
# that includes them measures them instead of the face. Both heads are >= 20 px
# and one is the blond-on-fair worst case the brief asks to be run.
EZ = {
    'blueMid':  (647, 606, 683, 642),
    'goldFront': (941, 616, 981, 660),
}

def fill_holes(m):
    """Flood the outside; whatever is left unreached and unset is a hole."""
    H, W = m.shape
    out = np.zeros_like(m)
    stack = []
    for x in range(W):
        for y in (0, H - 1):
            if not m[y, x] and not out[y, x]:
                out[y, x] = True
                stack.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if not m[y, x] and not out[y, x]:
                out[y, x] = True
                stack.append((y, x))
    while stack:
        cy, cx = stack.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < H and 0 <= nx < W and not m[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                stack.append((ny, nx))
    return m | ~out

def components(m):
    m = m.copy()
    H, W = m.shape
    out = []
    for y in range(H):
        for x in range(W):
            if not m[y, x]:
                continue
            stack, n = [(y, x)], 0
            m[y, x] = False
            while stack:
                cy, cx = stack.pop()
                n += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < H and 0 <= nx < W and m[ny, nx]:
                            m[ny, nx] = False
                            stack.append((ny, nx))
            out.append(n)
    return sorted(out, reverse=True)

def stencils(mask, b):
    """sclera / iris+pupil / aperture, from the DEBUG_MASK frame inside box b.

    Channel DOMINANCE with a margin, because bloom and the grade desaturate the
    flat hatch badly. Skin is always r > g > b and is never blue- or
    green-dominant, which is the whole reason this separates at all.
    """
    x0, y0, x1, y1 = b
    c = mask[y0:y1, x0:x1].astype(np.float64) + 1e-6
    r, g, bl = c[..., 0], c[..., 1], c[..., 2]
    sclera = (bl > r * 1.06) & (bl > g * 1.02)
    iris = (g > r * 1.06) & (g > bl * 1.02)
    iris = fill_holes(iris) & ~sclera         # swallow the bloomed-out pupil
    return sclera, iris, sclera | iris

def disc(shape, cy, cx, rad):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= rad * rad

def eye(name, L, mask, ebox, _unused, obox, rep, over=None):
    x0, y0, x1, y1 = ebox
    sc, ir, ap = stencils(mask, ebox)
    sub = L[y0:y1, x0:x1]
    # THE CHEEK BOX IS DERIVED FROM THE APERTURE, NOT HAND-PLACED. Every number
    # in the brief is a ratio against "the cheek below it", and on this face a
    # box moved 30 px laterally reads 0.24 or 0.55 depending on which facet it
    # lands on — enough to move the sclera ratio from 0.77x to 0.94x without
    # touching a shader. So it is defined mechanically off the mask: the
    # aperture's own x-span, in a 14 px band starting 4 px below the aperture's
    # lowest pixel. Reproducible, un-shoppable, and it follows the eye if a peer
    # moves the head.
    ays, axs = np.nonzero(ap)
    cy0 = y0 + int(ays.max()) + 4
    cbox = (x0 + int(axs.min()), cy0, x0 + int(axs.max()) + 1, cy0 + 14)
    cheek = float(L[cbox[1]:cbox[3], cbox[0]:cbox[2]].mean())
    orbit = float(L[obox[1]:obox[3], obox[0]:obox[2]].mean())
    apN = int(ap.sum())

    # Pupil: an analytic inner disc, CENTRED ON THE HATCH'S RED, not on the iris
    # blob's centroid. The two are 3 px apart here — the lid crops the iris
    # asymmetrically and the gaze is off-axis, so the blob's centroid sits below
    # and nasal of the real pupil — and at a 2 px radius that offset means you
    # are measuring inner stroma and calling it pupil. Radius from
    # pupilR/irisR = 0.135-0.165 over 0.478-0.528 (PlayerMaterial.ts).
    pu = np.zeros_like(ir)
    if ir.any():
        c = mask[y0:y1, x0:x1].astype(np.float64) + 1e-6
        # Eroded, because the hatch's iris/skin boundary pixels are bloomed
        # toward skin and skin is the reddest thing in the box: un-eroded, the
        # "most red pixel in the iris" is a lash, and the disc lands 4 px off.
        inner = ir.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            inner &= np.roll(np.roll(ir, dy, 0), dx, 1)
        if not inner.any():
            inner = ir
        red = np.where(inner, c[..., 0] / c[..., 1], -1.0)
        k = max(3, int(inner.sum() * 0.04))
        idx = np.argsort(red.ravel())[-k:]
        pys, pxs = np.unravel_index(idx, red.shape)
        rad = np.sqrt(ir.sum() / np.pi)
        pu = disc(ir.shape, pys.mean(), pxs.mean(), max(1.0, rad * 0.30)) & ir
        pupilCentre = [int(x0 + pxs.mean()), int(y0 + pys.mean())]
    else:
        pupilCentre = None

    r = {
        'aperturePx': apN,
        'cheekMean': round(cheek, 4),
        # 4.3 — iris+pupil >= 40% of aperture
        'irisPupilPctOfAperture': round(100.0 * float(ir.sum()) / max(apN, 1), 1),
        # 4.4 — orbital band <= 0.85x cheek
        'orbitOverCheek': round(orbit / cheek, 3),
        'pupilCentre': pupilCentre,
        'cheekBox': list(cbox),
    }
    # 4.2 — zero sclera above the iris top
    if ir.any():
        top = int(np.argmax(ir.any(axis=1)))
        r['irisTopRow'] = y0 + top
        r['scleraAboveIrisTop'] = int(sc[:top, :].sum())
    else:
        r['scleraAboveIrisTop'] = -1

    # 4.1 — pixels >= 1.3x cheek inside the aperture, and how they clump.
    hot = ap & (sub >= cheek * 1.3)
    comp = components(hot)
    r['pxOver1_3xCheek'] = int(hot.sum())
    r['hotBlobs'] = comp[:4]
    hys, hxs = np.nonzero(hot)
    r['hotPx'] = sorted([[int(x0 + hx), int(y0 + hy), round(float(sub[hy, hx] / cheek), 2)]
                         for hy, hx in zip(hys, hxs)], key=lambda t: -t[2])[:14]
    # The mask hatch blooms about a pixel past the geometry, so the outermost
    # ring of the aperture stencil can be lid or lash rather than globe. Report
    # the eroded count too, and never quote only the flattering one.
    er_ = ap.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        er_ &= np.roll(np.roll(ap, dy, 0), dx, 1)
    r['pxOver1_3xCheekEroded'] = int((er_ & (sub >= cheek * 1.3)).sum())
    if er_.any():
        ev = np.sort(sub[er_])
        ecomp = components(er_ & (sub >= cheek * 1.3))
        drop = ecomp[0] if ecomp else 0
        r['erodedMaxXCheek'] = round(float(ev.max()) / cheek, 3)
        k2 = ev[:len(ev) - drop] if drop < len(ev) else ev[:0]
        r['erodedMaxNonCatchlight'] = round(float(k2.max()) / cheek, 3) if k2.size else None
        r['erodedScleraXCheek'] = round(float(sub[er_ & sc].mean()) / cheek, 3) if (er_ & sc).any() else None

    # THE CATCHLIGHT, measured where it lives: on the cornea. It is not a
    # cheek-relative quantity — the brief allows it to clip — so it is found as
    # the brightest connected blob inside the iris stencil and reported with its
    # size and its position in iris radii, y positive UP. "One per eye, <= 3 px,
    # upper quadrant" is three numbers and all three are countable.
    if ir.any():
        iv = sub[ir]
        thr = max(float(iv.max()) * 0.72, cheek * 0.9)
        cl = ir & (sub >= thr)
        ccomp = components(cl)
        cys, cxs = np.nonzero(cl)
        iys, ixs = np.nonzero(ir)
        rad = np.sqrt(ir.sum() / np.pi)
        r['catchlight'] = {
            'blobs': ccomp[:3], 'n': int(cl.sum()),
            'peakXCheek': round(float(iv.max()) / cheek, 2),
            'offsetIrisRadii': [round(float((cxs.mean() - ixs.mean()) / rad), 2),
                                round(float((iys.mean() - cys.mean()) / rad), 2)],
        }

    # MIDTONE MEANS MIDTONE: the catchlight is a clipped highlight sitting on
    # the iris and it is explicitly exempt from every cap in the brief, so it
    # comes out of both the iris and the pupil statistics. Left in, a 5 px dot
    # at 2.8x cheek drags a 150 px iris from 0.59x to 0.74x and reports a pass
    # on a band the shading never entered.
    cl = np.zeros_like(ir)
    if 'catchlight' in r:
        cl = ir & (sub >= max(float(sub[ir].max()) * 0.72, cheek * 0.9))
    for key, m in (('sclera', sc & ~cl), ('irisMid', ir & ~pu & ~cl), ('pupil', pu & ~cl)):
        if m.any():
            v = sub[m]
            r[key] = {'n': int(m.sum()),
                      'xCheekMean': round(float(v.mean()) / cheek, 3),
                      'xCheekMax': round(float(v.max()) / cheek, 3)}
        else:
            r[key] = {'n': 0}
    # Everything on the globe that is not the single largest hot blob must obey
    # the 1.3x cap; that blob is the catchlight allowance.
    v = np.sort(sub[ap])
    drop = comp[0] if comp else 0
    keep = v[:len(v) - drop] if drop < len(v) else v[:0]
    r['maxNonCatchlightXCheek'] = round(float(keep.max()) / cheek, 3) if keep.size else None
    rep[name] = r
    if over is not None:
        o = over[y0:y1, x0:x1]
        o[sc] = (0, 90, 255)
        o[ir & ~pu] = (0, 220, 0)
        o[pu] = (255, 0, 0)
        o[hot] = (255, 255, 0)
        for bb, col in ((cbox, (255, 0, 255)), (obox, (0, 255, 255))):
            over[bb[1]:bb[3], bb[0]:bb[0] + 1] = col
            over[bb[1]:bb[3], bb[2] - 1:bb[2]] = col
            over[bb[1]:bb[1] + 1, bb[0]:bb[2]] = col
            over[bb[3] - 1:bb[3], bb[0]:bb[2]] = col

def endzone(path, rep):
    L = lum(np.asarray(Image.open(path).convert('RGB')))
    for nm, b in EZ.items():
        x0, y0, x1, y1 = b
        v = L[y0:y1, x0:x1]
        m = float(v.mean())
        rep.setdefault('endzone', {})[nm] = {
            'box': b, 'faceMean': round(m, 4), 'n': int(v.size),
            'pxOver1_4xFaceMean': int((v > m * 1.4).sum()),
            'maxOverFaceMean': round(float(v.max()) / m, 2)}

def main():
    argv = sys.argv[1:]
    shaded, maskp = argv[0], argv[1]
    img = np.asarray(Image.open(shaded).convert('RGB'))
    L = lum(img)
    M = np.asarray(Image.open(maskp).convert('RGB'))
    rep = {'shaded': shaded, 'mask': maskp}
    over = img.copy() if '--overlay' in argv else None
    eye('eyeL', L, M, BOX['eyeL'], BOX['cheekL'], BOX['orbitL'], rep, over)
    eye('eyeR', L, M, BOX['eyeR'], BOX['cheekR'], BOX['orbitR'], rep, over)
    if '--endzone' in argv:
        endzone(argv[argv.index('--endzone') + 1], rep)
    if over is not None:
        p = argv[argv.index('--overlay') + 1]
        Image.fromarray(over).crop((800, 210, 1010, 320)).resize((210 * 6, 110 * 6), Image.NEAREST).save(p)
        rep['overlay'] = p
    print(json.dumps(rep, indent=1))

if __name__ == '__main__':
    main()
