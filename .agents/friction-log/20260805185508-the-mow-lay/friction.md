---
title: 'The mow LAY DIRECTION is duplicated in the turf shader and the grass system with nothing shared but a width constant'
severity: 'minor'
---

`MOW_STRIPE = 5.2` in `src/world/field/Layout.ts` is imported by both
`src/world/field/TurfMaterial.ts` and `src/world/grass/shader.ts`, and both
files carry a comment insisting the two must agree or "the painted stripe and
the physical lean drift apart and the anisotropy stops reading as one surface".

But only the *width* is shared. The lay direction — which axis the bands run
on, and which way the blades lean inside each band — is written out
independently in each file:

- turf: `cos(pi * (P.x / uStripeWidth + wobble))`, a signed lay along X;
- grass: `sSign = mod(floor(wxz.x / uStripeW + 0.5), 2) < 0.5 ? 1 : -1`, a lean
  along X.

So the invariant the comments are defending is not actually enforceable from
one place. I have just added a second lay direction to the turf — the endzone
cross-cut runs at 45 deg — and the 3D grass blades inside the endzone still
lean along X, because I own `TurfMaterial.ts` and not `Grass.ts`. The two
surfaces now disagree wherever both are drawn.

How much this shows: the grass rings stop at ~36 m from the camera at `high`
(`OUTER_DENSITY` in `grass/scatter.ts`), and the tele works at 40-60 m, so the
broadcast frames are turf-only and unaffected. It is the close endzone shot
where both are on screen, and there the per-blade yaw scatter in the grass
shader is already +/-73 deg, so the disagreement is a soft one rather than a
visible plaid. It is still a latent inconsistency and it will get worse if
anyone strengthens either model.

The fix is a shared source for the lay VECTOR, not just the width — one
function in `Layout.ts` (or a GLSL snippet exported next to `GROUND_NOISE` in
`field/GroundShader.ts`, which is already the module for shading plumbing that
more than one surface needs) returning a `vec2` lay for a world XZ, consumed by
both. That is a two-file edit and it crosses an ownership boundary, which is
why it is logged rather than done.
