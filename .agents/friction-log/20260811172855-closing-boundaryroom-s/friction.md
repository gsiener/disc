---
title: 'Closing boundaryRoom''s target-clamp gap moved a butterfly-sensitive test-ai.ts assertion'
severity: 'minor'
---

## Description

Fixing issue #33 (`boundaryRoom`'s speed cap reads zero room for a body resting on
its own inset line, aimed even slightly further out) required clamping every
target inside `boundaryRoom`'s own margin (0.55 m) at the single choke point,
`TeamAI.intent()` in `src/sim/AI.ts` (and its Swift mirror, `TeamAI.intent()` in
`swift/Sources/UltimateSim/AI/TeamAI.swift`).

Most existing call sites already clamped tighter than 0.55 m and are unaffected.
Two call sites (offence and defence "attack disc in flight" — `AI.ts` lines
~2778 and ~3280) clamped looser, at 0.45 m, an unnamed instance of the exact
same defect class one margin-width narrower. Tracing it live (a temporary
`AI_TRACE_CLAMP` env-gated log in `intent()`, since removed) showed the new,
tighter clamp actually firing **~9,786 times** in one `tools/test-ai.ts` run —
this is not a rare corner case, it is "anyone contests a disc within half a
metre of a sideline or end line," which a multi-point match hits often.

## The consequence worth recording

Tightening that one margin is a genuine, deterministic behaviour change near
boundaries, even though the fix is "just" a target clamp (option 2 of the
issue, not option 1's cap-math rewrite). In `tools/test-ai.ts`'s "4 seeds x 6
points, SHIPPING config" shape run, it changed which bodies were where by
`t=368s`, and a previously-absent layout bid appeared (`#2O`, 0.91 m of
standing slack — the "nobody dives for a disc he could run down" assertion,
which documents "zero bids is a pass and is the usual result here").

Pooled over 16 additional seeds (77 completions total, up from ~20), the extra
bid did not reproduce or worsen — it stayed at exactly the one event from the
original 4 seeds. That is the AGENTS.md pooling test for "is this noise or a
real defect" pointing at noise: a real regression in `wantsBid`/`shouldBid`
(both untouched by this fix) would show up more than once in 4x the sample.
This is n=1 flipping a ratio-based assertion that has no gradation at n=1 (0%
or 100%, nothing between), on a chaotic deterministic scenario the test's own
comment already calls out ("a single 8-point run is chaotic").

Left as-is, not weakened: it is not a confirmed defect, so there is nothing to
fix, and a future agent who reruns this exact test after touching `AI.ts` should
know this specific failure is expected drift from issue #33's fix, not
necessarily theirs.

## What would help

A test-ai.ts convention (already used for SELECT_SEEDS/SWEEP_SEEDS elsewhere in
this same file) for the "layout audit" bid-quality gate too: pool a handful of
scenarios before evaluating a ratio, rather than evaluating a rate on whatever
single scripted run happens to produce. n=1 cannot distinguish "rare" from
"always."
