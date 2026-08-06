---
title: 'Section 4 is countable only with a per-material mask pass, and capture.mjs has none — so every round has hand-boxed its own numbers'
severity: 'minor'
---

Every hair acceptance number in `docs/face-direction.md` section 4 is a RATIO between two regions of the frame — "hair mean 0.8-1.3x the same-side forehead", "per-column fringe erosion 4-10 px", "no connected eroded region wider than 8 px", "no scalp pixel above the visible hairline brighter than face mean". None of them can be counted without knowing, per pixel, which material drew it. `tools/capture.mjs` gives you one PNG and nothing else, so the only options are a hand-typed bounding box (wrong the moment the tableau or the athlete changes — the closeup picks a different athlete per seed, and on seed 7 the head is cropped by the top of the frame) or eyeballing, which is how six rounds have reported "correct but invisible".

What worked, in ~40 lines on top of capture.mjs: drive `window.__ENGINE__.ctx.scene`, collect materials by `m.name` (they are all named `player.*`), and shoot the same pinned frame four times.

    <shot>.png         normal
    <shot>_nohair.png  player.hair .visible = false      -> background plate
    <shot>_mask.png    player.hair emissive magenta      -> exact silhouette
    <shot>_shell.png   + alphaTest = 0                   -> shell BEFORE erosion

`hair = mask - nohair`, `shell - hair` is exactly what the erosion removed, and per-column `shell.max(y) - hair.max(y)` is the fringe depth in pixels, which is the brief's unit. That last pair is the only way to answer "does the erosion actually fire" — an earlier round proved the term was arithmetically incapable of removing a pixel, and reading the code cannot tell you whether the fix worked.

Two traps worth writing down:

1. **Do not build the mask from an A/B luminance diff.** I did first, and it shrinks exactly where the value work lands: hair that gets closer to the skin under it falls below the diff threshold and drops out of the mask, so the mean it feeds is biased bright and the change you just made appears to have done nothing. Cost me one full iteration reading "no effect" off a real 1.5x effect. Flag with emissive instead.
2. **Keep the flag under the clip point.** `emissiveIntensity = 6` tone-maps to white, and white has no hue, so a magenta test only caught the rim of the cap — 6k px of a 17k px mask. 0.9 is fine.

Also: every `player.*` material is reachable many times through the scene graph (42 hits for one material), so a probe that saves state before mutating must dedupe or guard the save, or the "restore" writes back the value it just wrote.

Suggested home: a `--mask <materialName>` flag on capture.mjs, since this is now needed by hair, skin, eyes and cloth alike.
