---
title: 'A lit/shadow split is still too coarse for a hair cap: the front and the temple of the SAME half fail in opposite directions, through different terms'
severity: 'minor'
---

Friction 20260806003547 established that pooling the hairline into one distribution hides a bimodal failure and that the fix is to split lit vs shadow. That is right and it is still not enough. Split by side, seed 0 reads:

    shadow  step med 0.591   p05 0.425  p95 1.464
    lit     step med 0.686   p05 0.424  p95 1.103

which looks like "uniformly a bit dark, wide". It is not. Bin the same 202 boundary columns by x and ablate each lighting path inside each bin (`tools/_hairmeas.mjs --abl`, then mask the 8 px band above the per-column hairline):

    x-band                 hair    fore    ratio | albedo  sheen   halo    lobes
    left temple  (32 col)  0.310   0.255   1.22  | 0.041   0.006   0.182   0.081
    FRONT       (103 col)  0.113   0.224   0.51  | 0.074   0.005   0.018   0.017
    right of ctr (34 col)  0.394   0.402   0.98  | 0.091   0.002   0.015   0.286
    lit temple   (33 col)  0.557   0.723   0.77  | 0.066   0.003   0.038   0.451

The temple and the front are **on the same half of the head** and they fail in opposite directions — 1.22x and 0.51x — because they are lit by different terms. Converted to linear radiance the albedo carries 25 % of the temple and **75 % of the front**; the backlit rim carries 81 % of the temple and 16 % of the front. Any single scale — `uValue`, a wrap constant, an occlusion — moves both together and cannot close them.

The cause, once you can see it, is one line: the rim is `bk * edge * edge`, an EDGE term, and the front of a cap on a portrait framing is not an edge. `edge` is ~0.15 there, so the rim is 2 % of itself; `dotNL` is negative under a back-and-above sun so the wrapped diffuse clamps to zero; `vis` floors the fibre lobes at 0.25 of nothing. Fifty pixels of cap directly above the eyes have literally no light path, and that is half the hairline.

**The cheap general test** is not "split by side", it is: for every acceptance clause that is a ratio, bin the boundary along its own length and ablate each lighting path inside each bin. Four numbers per bin, one extra capture (`--abl` shoots `_noalb`, `_nosheen`, `_noboth`, `_noglow` in the same run). Without it you get a mean that says "a bit dark everywhere" and you tune a global gain, which is what the previous two rounds did.

Corollary worth carrying to Skin.ts and cloth: **an edge-weighted term cannot be a material's main value carrier on a framing that is about the front of an object.** Anything of the form `pow(1 - dot(N,V), k)` is a rim light and is zero exactly where the camera is pointed.
