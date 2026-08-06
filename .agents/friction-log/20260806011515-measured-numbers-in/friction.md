---
title: 'Measured numbers in comments do not say which camera they were measured on, and the camera moved'
severity: 'minor'
---

This repo's best convention is that a tuning constant carries the measurement
that justifies it in a comment beside it. `src/world/field/TurfMaterial.ts` is
the strongest example: the endzone block states step sizes, band contrasts,
transfer rates and a sign flip, all with numbers.

None of them say what the CAMERA was when they were measured, and the camera
moved. `TELE.POS_Y` went 15 -> 22 in commit 2fe3074. Every endzone number in
that file was taken at 15. Re-measured today at 22 with `tools/_ezprobe2.mjs`
on the shipped tele framings:

| claim in the file | re-measured at POS_Y 22 |
|---|---|
| `uEzDC` 0.260 / `uEzAO` 0.055 gives "5.7-6.2 % in sun" | 12.4 % (redzone), 11.1 % (approach) A/B in sun |
| "12.5-14.2 % in ambient" | 19.8 % / 15.2 % A/B in shadow |
| "EZ 8.2 % diagonal / 3.0 % lengthwise vs FOP 4.1 / 9.9" | EZ 7.4 / 3.0 vs FOP 4.3 / 11.3 |
| `EZ_TILT` "sits at a sign flip at a coefficient of 0.27" | monotonic over 0 -> 0.45, no flip; sun bandD 8.27 -> 7.03, shadow bandD 13.29 -> 14.91 |

Two of those are now off by a factor of two, and the sign-flip claim -- which is
the stated reason a coefficient is 0.30 and not 1.0 -- does not reproduce at
all in the range it describes. The comment is not wrong about the physics; it
is wrong about the pitch it was measured on, and there is nothing in the text
that lets you notice.

The cost is not that the numbers are stale. It is that they are stale AND
authoritative: they read as the result of a sweep, so the next agent trusts
them instead of re-running the sweep, and the sweep is ten minutes.

Suggested convention, cheap to adopt: any measured number in a comment states
the rig it was taken on, in the same breath. "5.7 % in sun (tele POS_Y 15,
20 deg, 47 m)" is eight extra characters and it self-invalidates the moment
someone greps `POS_Y` after moving the camera. `tools/_ezprobe2.mjs` already
prints the distance for exactly this reason; the comments just do not carry it.
