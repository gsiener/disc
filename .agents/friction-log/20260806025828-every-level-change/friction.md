---
title: 'Every level change in a shader is diluted about 2.4x by the tone curve, so tuning a linear constant ''by 25 percent'' moves the graded pixel by 10'
severity: 'minor'
---

## What bit

All the acceptance numbers in `docs/face-direction.md` are ratios of
sRGB-encoded pixel values. All the constants you tune are linear. Between them
sits the tonemap plus the grade, and in the range this face occupies the
composite is close to a 1/2.4 power.

So:

| linear change | encoded change |
|---|---|
| x1.10 | x1.04 |
| x1.25 | x1.10 |
| x1.50 | x1.18 |
| x2.00 | x1.33 |

I raised the sclera albedo 0.520 -> 0.560 (linear x1.077) expecting the measured
ratio to move by about 7 percent. It moved by 0.3 percent, and I spent a capture
cycle looking for the clamp that was eating it. There is no clamp.

## Rule of thumb worth writing down

**To move a delivered ratio by N percent, change the linear constant by roughly
2.4 N percent.** Getting the sclera from 0.83x cheek to 0.95x — a 14 percent
move — needs the light or albedo up by 38 percent, which is the difference
between 'nudge a constant' and 'this is not reachable without restructuring',
and you want to know which one you are in before the third capture, not after.

Corollary: peaks are compressed harder than means, so range-compression work
looks better in the delivered frame than the linear arithmetic predicts, and
level work looks worse.
