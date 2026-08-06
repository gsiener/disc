---
title: 'The head mesh is tessellated at ~5 mm at the mouth, but every mouth feature in faceSurface is a 1.5-4 mm Gaussian'
severity: 'minor'
---

Measured on the hero athlete (`shots/faces/closeup.png` subject: team 0 slot 4, `ctx.rand.fork(4*7919+13)`, seed 20260729) with a probe that reproduces `buildHead`'s grid exactly.

The hero head LOD builds an 87 x 71 lat-long grid (`headU 56 * 1.55`, `headV 51 * 1.40`) with `warpV: 0.30` clustering rows toward the equator — i.e. toward the EYE LINE, `ny = 0`. That leaves the mouth, at `ny = -0.655` (`v = 0.728`), on the sparse side of the warp:

| landmark | quad size, hero LOD |
|---|---|
| eye line | 3.62 x 3.80 mm |
| lip line | ~4.9 mm row pitch (13.35 mm vertex-to-vertex, inflated by the crease's own 8.5 mm pull) |

And the features `faceSurface` sculpts there:

| feature | Gaussian sigma in `ny` | in mm |
|---|---|---|
| lip line `g1(ny, -0.655, 0.014)` | 0.014 | ~1.6 mm |
| commissure pit `g1(ny, -0.658, 0.038)` | 0.038 | ~4.5 mm |
| upper vermilion `g1(ny, -0.598, 0.030)` | 0.030 | ~3.5 mm |
| lower vermilion `g1(ny, -0.716, 0.036)` | 0.036 | ~4.2 mm |
| philtrum `g1(ny, -0.532, 0.048)` | 0.048 | ~5.6 mm |

Nyquist needs two rows inside a feature. At a 4.9 mm pitch the lip line gets **at most one** row, and whether it gets that one depends on where the warp happens to land the row — so the deepest single term in the whole mouth (0.105 R = 8.5 mm) either renders as a one-row spike or vanishes entirely, and which of the two you get is a function of `headV` and `charDetail`. That is why six rounds of mouth sculpting have been invisible: it is a sampling failure, not a shading one.

Two things follow for anyone working this file:

1. Sculpt amplitude is not the lever. Adding depth to a sub-Nyquist feature adds aliasing, not a mouth.
2. `warpV` is aimed at the wrong latitude. It is symmetric about `v = 0.5`, so it buys the eye line resolution and pays for it at BOTH poles — but the face's second dense band is the mouth, three quarters of the way down, not the crown.
