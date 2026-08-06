---
title: 'Turf mow lay double-counts: normal tilt and albedo term can cancel, and whether they do depends on sun azimuth vs lay axis'
severity: 'minor'
---

Diagnosed while adding a second mow direction (the endzone cross-cut) to
`src/world/field/TurfMaterial.ts`. Cost about 40 minutes and three probe runs to
find, and it is invisible as long as there is only one lay axis, so it will
bite the next person who adds one.

The mow stripe is modelled TWICE in `turfShade`:

1. an albedo term — `aniso = dot(lay, 0.95*look + 0.30*sun)`, then
   `col *= 1.0 + aniso * 0.50`;
2. a normal tilt — `pert += lay * 0.30`, which reaches the light through
   `N·L`.

They are the same physical effect (bent blades presenting backs or tips), so
they add. Whether they add *constructively* depends on the sign of the sun's
horizontal component along the lay axis, which is not something either term
looks at:

- albedo sign follows `sign(0.95*look_a + 0.30*sun_a)`;
- `N·L` sign follows `sign(-uSunDir_a)` = `sign(sun_a)`.

For the base cut (lay along X) under this venue's arc — `uSunDir` measured at
`(-0.436, 0.528, -0.729)` at hour 17.2, i.e. the sun runs mostly DOWN-PITCH —
`sun_x` is small, the two terms mildly oppose, and the stripes survive at about
two thirds strength. Nobody noticed.

For a lay along Z the sun component is `-0.729`, the two terms oppose hard, and
the rendered band is not merely weaker, it is non-monotonic in `lay`: with the
tilt at the base cut's own 0.30 the products for lay = +1, 0, -1 come out
0.406 / 0.528 / 0.451. Both the bright and the dark band render *darker than
neutral*, the fundamental cancels, and the stripe disappears.

Measured, lit endzone at 47 m, 30 deg lens, detrended band contrast:

| cross-pass normal tilt | in sun | ambient only |
|---|---|---|
| 0.30 (same as base cut) | 1.7 % (floor 1.1 %) | 10.1 % |
| 0.10 | 3.2 % | 6.9 % |
| 0.00 | 5.2 % | 5.7 % |

The sign flip sits either side of a tilt coefficient of ~0.27, so at 0.30 it
lands essentially on the cancellation point.

The trap: "in sun it vanishes, in ambient it is fine" reads like a lighting or
shadow-map bug, not a shader-algebra bug, and I spent the first two probe runs
looking in the wrong place. Anyone adding a third lay direction (a chequer, a
diagonal, a centre-circle-style feature) will hit the same wall.

Repro: `artifacts/_ezprobe.mjs`, which pins a camera, reads the framebuffer
back and reports detrended per-axis band contrast for two world-space regions.
`--cuts 0,1` A/Bs it through the `uCrossCut` uniform. Run it against a *lit*
endzone (`--only ez-lit`): with the endzone in the west stand's shadow the
shadow edge dominates the statistic and hides the effect entirely.
