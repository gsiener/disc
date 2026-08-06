---
title: 'A bright ground hemisphere in an env map silently costs you the whole map, because three''s irradiance lookup is a GGX convolution'
severity: 'minor'
---

Hit while building a night IBL in `src/render/Lighting.ts`.

`AmbientRig` normalises `scene.environmentIntensity` so the bound PMREM
delivers exactly its share of the sky budget:

    i = clamp(SHARE_ENV * skyBudget / measured.upLuma, 0.02, 3.0)

and `EnvMeter` gets `upLuma` from `textureCubeUV(env, +Y, 1.0) * PI`, which is
what three's own `getIBLIrradiance` does. The comment in EnvMeter says "the
roughness-1 mip of a PMREM chain *is* the cosine-convolved irradiance map".
It is not. It is a **GGX** convolution at roughness 1, and its lobe has a tail
that reaches well past the horizon — so radiance in the **ground** hemisphere
leaks into the up-facing sample.

Measured, baking a stadium-at-night map (dark blue sky + glow dome + four
floodlight discs above, floodlit pitch below), authoring the ground half at the
0.45 share `Ambient.BOUNCE_PROBE_FOREIGN` assumes a foreign PMREM carries:

| authored sky up-irradiance | 0.065 |
| measured upLuma            | 0.237 |
| leak from the ground half  | 0.172 (73% of the measurement) |
| solved environmentIntensity| 0.27  |

The consequence is not a small error, it is a **trap with a sign flip**:

1. everything the map exists for — in my case four small bright fixture racks,
   the thing a night frame needs a specular kick from — comes back 1.9 stops
   dimmer than authored, because `i` scales the *whole* map;
2. and the side irradiance you were buying with that bright ground **saturates
   and then stops responding entirely**. With
   `upLuma = E_sky + lambda*G` and `i = B/upLuma`, the env's side contribution is
   `sigma*G*B/(B + lambda*G)`, which tends to `sigma*B/lambda` as `G` grows.
   Measured ceiling here was 0.073 against the 0.102 the budget wanted, so no
   amount of extra ground radiance could ever reach the target — a brighter
   ground made the reflections worse and the fill no better.

So an env map bound through a normalising ambient solver has a hard limit on
how much of a **bounce** it can carry, set by the sky budget and the leak
coefficient, not by what you author. Past that limit the ground half must be
treated as a *hue* term only and the bounce handed to the SH probe instead
(`AmbientRig.tuning.bounce`).

How to see it in ten seconds, rather than deriving it: bake, then read
`ctx.scene.environmentIntensity`. If it is far below 1 while you authored the
map to meet the budget exactly, the ground half is eating the measurement.
`lightReport()` now returns it as `envIntensity` for that reason.

The one-line fix in EnvMeter would be to sample the +Y irradiance from a
direction set that excludes the lower hemisphere, or to document the leak and
expose it — but the honest fix is that a GGX roughness-1 mip is not an
irradiance map and the two are ~3.6x apart for a map with a bright floor.
