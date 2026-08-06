---
title: 'Section 4.7''s bright-scalp clause is unsatisfiable from Hair.ts: it fails on the very comb it also demands'
severity: 'minor'
---

`docs/face-direction.md` 4.7 asks the fringe for two things at once:

> per-column erosion depth 4-10 px at closeup … and **no scalp pixel above the
> visible hairline brighter than face mean**

Those are in direct conflict on a side-lit head, and the conflict is arithmetic, not tuning.

Measured on the shipped closeup with `tools/_hairmeas.mjs` + `tools/_hairscalp.py`, seed 0:

    face mean (pooled over the whole head)      0.304
    shadow-side forehead                        0.244
    lit-side forehead                           0.451     <- 1.85x the shadow side
    exposed inter-tooth skin, px                1640
    …of those, brighter than face mean           442       (27 %)
    widest 8-connected bright run                 62 px    (clause says 8 px)

The 442 failing pixels are **not** a notch. Paint `shell & ~hair` red over `hair` green and look: the eroded set is one clean 4-10 px comb the whole way along the hairline, exactly what the same clause asks for. It fails only because the face mean pools a face whose two halves differ by 1.85x, so *every* pixel of comb on the lit half is "brighter than face mean" before the hair shader has done anything. Erode 4 px and you still expose lit forehead; erode 0 px and you fail the depth clause.

I spent one render cycle proving this the expensive way — extending the boundary guard from vLen 0.10-0.18 to 0.26-0.48 on the theory that a grazing dissolve was biting the temple. It moved the eroded set by three pixels and no acceptance number at all, and I reverted it.

Two things would make the clause countable:

1. **State it against the same-side forehead**, not the pooled face mean — every other clause in 4.7 is already same-side ("hair mean 0.8-1.3x the *same-side* forehead"). On that unit seed 0 reads 1.06x on the shadow half and 0.98x on the lit half, i.e. the exposed skin is not anomalous at all.
2. If what the clause actually wants is **the fringe's shadow on the forehead**, that is not a Hair.ts term. The cap is a single alpha-tested shell; the skin between two teeth is lit by whatever `Lighting.ts` and the shadow map give it, and neither sees the gaps. It belongs to the shadow pass or to Skin.ts, and no hair edit can reach it.

Generalisable: an acceptance clause that compares a **local** region against a **globally pooled** reference is unsatisfiable whenever the pooled reference spans a big lighting gradient. Same trap is sitting in 4.1 ("pixels >= 1.3x *cheek* mean inside each eye aperture") and 4.6 ("adjacent-mean ratio") — those two are local/local and fine — but anything of the form "no X brighter than *face* mean" will fail on the lit half of any side-lit head.
