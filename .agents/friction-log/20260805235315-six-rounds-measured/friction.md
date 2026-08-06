---
title: 'Six rounds measured the vermilion against a box sitting on the underside of the nose, so the mouth could not be fixed by fixing the mouth'
severity: 'minor'
---

`docs/face-direction.md` section 4.5 asks for "vermilion 0.70-0.80x philtrum".
Every round has reported that number at ~0.92-1.01x and concluded the lip
rotation was too weak. It was not. **The philtrum box was on the nose.**

Measured on `shots/fm-final/closeup.png` (hero athlete, seed 20260729), with
the boxes drawn back onto the render to check them by eye:

| box | y range | what is actually inside it |
|---|---|---|
| "philtrum", as used | 334-352 | the nostril sill and the shadow under the nose |
| philtrum, correct | 358-368 | the philtrum |
| "vermilion", as used | 356-401 | both lips *plus* the philtrum *plus* chin |
| vermilion, correct | 369-389 | both lips |

The nostril sill carries the strongest cavity lobe on the lower face
(`0.52 * g1(hy, nt - 0.075, 0.032)` in `FaceMap.ts`), so the reference was
~20 % darker than real philtrum skin. A lip that had genuinely reached 0.77x
of its surround read as 0.98x, and the error is in the direction that makes
the fix look like it did nothing — which is exactly the "correct but
invisible" verdict the round-7 brief opens by describing.

Same frame, same code, two rulers:

    facecheck.py  (hand-typed box)   vermilion/philtrum 0.980
    skinnum.py    (derived box)      vermilion/philtrum 0.772   <- in the window

**The generalisable trap.** A hand-typed acceptance box is a *hypothesis about
where the anatomy is*, and it is never re-checked, because checking it costs a
capture and it looks like a constant. Three agents inherited this one by
copying the checker.

**What worked.** Anchor every box to a landmark the RENDER can be asked for,
not to a pixel coordinate:

1. Add a debug mode to the material that writes its own masks into the albedo
   (`uDbg = 2` in `Skin.ts`, ships at 0).
2. Find the oral line as the cavity channel's peak *inside* the lip mask —
   restricting to the lip mask is what keeps it off the taller nostril-sill
   lobe.
3. Place every box as an offset from the oral line in units of the interocular
   distance.

The oral line does not move when the thing under test changes: across four
iterations it landed at y 377-378 while the lip mass itself went from 34 px to
31 px tall. **Do not anchor the box to the feature being modified** — my first
attempt sized the vermilion box off the lip mask's own extent, and it moved
with every edit, which silently rescaled the ruler and reported a real 0.88 ->
0.79 improvement as 0.98 -> 0.82.

Suggested fix: `skinnum.py`'s box derivation belongs next to the checker in the
repo, and section 4 should state its boxes as landmark offsets rather than
leaving each round to guess pixels.
