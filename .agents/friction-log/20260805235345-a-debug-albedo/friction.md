---
title: 'A debug albedo cannot be read as an absolute value: the tone curve makes ''is the albedo load-bearing'' answerable only as a ratio against a flat pass'
severity: 'minor'
---

Following `20260805230939-the-hair-cap`'s advice ("before tuning any material's
colour, measure what fraction of its rendered value the albedo path carries"),
I built the same probe for `player.skin` — a `uDbg` uniform that replaces the
computed albedo with a constant grey — and then made the mistake the hair entry
does not warn about.

**What I did wrong.** I wrote the shader's internal fields into the albedo
(`diffuseColor.rgb = vec3(expo, cavity, vLen)`), rendered, and divided the
result by a lighting estimate to recover the field values. The recovered
numbers were confidently wrong: `expo` came back 0.815 on a forehead where the
code makes it identically 1.0, and `cavity` came back 0.32 on a forehead where
it is ~0. Everything landed in a narrow band around 0.7-0.77 regardless of what
the field actually was, because what I was really measuring was the tone curve.

The render pipeline applies exposure, a filmic curve and a grade after
lighting. `f(light x albedo)` is not `f(light) x albedo`, and near the middle of
the curve everything compresses toward the same value. I spent about an hour
attributing a real defect to `expo`, then to the tan mix, on the strength of
those numbers — and the tan turned out to be worth ~1 % of value on a fair
athlete, because `uToneTan` in `Tone.ts` is `melanin * 1.32 + 0.03`, which is a
hue move, not a value move.

**Two rules that do survive the tone curve.**

1. **Ratios between two passes at the same pixel.** `shipped / flat` at one box
   is fine. Comparing an absolute recovered field between two boxes at
   different exposures is not.
2. **Comparisons between CHANNELS of the same pixel.** This is the useful one
   and it is exact enough for classification. To answer "which body part drew
   this pixel", write `vec3(pNeck, pTorso, ...)` and ask whether R > G. Both
   channels take the same light and very nearly the same curve, so the
   comparison cancels it. That settled in one capture a question I had been
   arguing from source for half an hour — and it showed my boxes were right
   (100.0 % `pNeck` / 100.0 % `pTorso`) when I had started to suspect they were
   the bug.

**Concrete result the probe did deliver.** For the collar boundary that
section 4.6 fails at 2.05x: with every skin term replaced by one constant grey,
the same two boxes still read **1.35x**. That is the ceiling any amount of paint
in `Skin.ts` can reach, and it is above the 1.25x acceptance. The step is a
lit chest against a shadowed neck with no contact shadow from the collar — it
is geometry and shadowing, not albedo. Without the flat pass I would have spent
the round tuning a tan line that cannot move the number, which is what the
brief's own text ("cut the tan mix 0.85 -> 0.55") would have led me to do.

Worth adding to the hair entry's lesson: the flat pass tells you the CEILING as
well as the share. If the flat-pass ratio already fails the acceptance, stop —
the number does not belong to the material you are editing, and finding that
out costs one capture.
