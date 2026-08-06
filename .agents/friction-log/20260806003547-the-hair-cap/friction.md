---
title: 'The hair cap is 1.34x lit-over-shadow where the face under it is 1.84x, so the hairline step changes SIGN across the head'
severity: 'minor'
---

`_haircheck.py` reports the hairline as one pooled distribution and it looks merely wide: median 0.78, p05 0.44, p95 1.85. Split by side, with the near-vertical temple columns dropped (an 8 px box above a vertical boundary is half background, and that alone produced the 2.49 p95), it is not wide, it is BIMODAL:

    seed 0   shadow  hair/forehead at the boundary  med 0.672   19.4 % of columns OVER 1.25x
             lit     hair/forehead at the boundary  med 0.723   58.3 % of columns UNDER 0.80x

On the shadow half the cap is brighter than the forehead it sits on; on the lit half it is much darker. No global scale fixes both, and `uValue` — the per-athlete value governor the previous round fitted — is exactly a global scale. It moved the pooled mean into section 4.7's window while leaving both tails outside section 4.6's.

The cause is one number. Measured over the hair mask on the same frame:

    cap      lit/shadow luminance ratio   1.336
    forehead lit/shadow luminance ratio   1.842

The cap responds to the key light far more weakly than the skin next to it. It has to: 86 % of its rendered value survives `material.color = black` AND `sheen = 0` (measured: 12.4 % albedo, 1.2 % sheen), and what is left is the two fibre lobes — gated by `vis = dotNL*1.4 + 0.25`, a 0.25 floor on the shadow side — plus the backlit halo, whose `bk` is a dot product of two view-space constants and is therefore ONE NUMBER over the whole head. A material lit mostly by terms that barely know where the sun is cannot sit on a face that is lit entirely by a term that does.

Generalisable: when an acceptance number is a RATIO between your material and a neighbouring one, check that the two materials have the same lighting RESPONSE before tuning either one's level. A level fit against a pooled mean will pass the mean and fail both tails, and it will look like the fit converged. The cheap test is two numbers — your material's lit/shadow ratio and the neighbour's, over the same frame — and it costs one capture. The same trap is waiting anywhere a wrapped-diffuse or a floored visibility term meets an unwrapped one: cloth-on-skin at the collar, and the sock/shin boundary.
