---
title: 'three''s clearcoat bypasses reflectedLight entirely, so every socket occlusion written against reflectedLight.* misses the brightest term on the material'
severity: 'major'
---

## What happened

`Eyes.ts` had four carefully-written occlusion lines at `lights_fragment_end`:

```glsl
reflectedLight.indirectDiffuse  *= lidAo;
reflectedLight.indirectSpecular *= 0.28 + 0.72 * lidAo;
reflectedLight.directSpecular   *= mix(0.45 + 0.55 * lidAo, 1.0, limbus * 0.8);
```

with a comment explaining that skipping them 'is why two white bars stayed the
brightest thing on a shadowed face at broadcast range'. The material has
`clearcoat: 1.0, clearcoatRoughness: 0.018`. **None of those lines touch the
clearcoat.**

In three 0.185, `lights_physical_pars_fragment.glsl` declares

```glsl
vec3 clearcoatSpecularDirect   = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
```

as file-scope globals, and `meshphysical.glsl` adds them at the very end:

```glsl
outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc )
              + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
```

So a mirror-smooth coat over the whole globe kept reflecting a full sky
hemisphere at full strength through every occlusion in the file. Three rounds of
comments in `Eyes.ts` describe fighting a 'quarter-globe specular smear' by
lowering the sclera albedo (0.50 -> 0.395 -> 0.315). The albedo was never
reachable to that term.

## Why it is worth an entry

This is the *shape* of the invisible-work failure the face rounds keep hitting,
and it is not specific to eyes. Any material that patches `reflectedLight.*`
after `lights_fragment_end` and also sets `clearcoat`, `sheen`,
`transmission` or `iridescence` has the same hole: those four all accumulate
into their own globals, not into `reflectedLight`. `Kit.ts` and `Hair.ts`
both use sheen.

## The fix, and the grep

```glsl
// after <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= corneaMask;      // gates BOTH clearcoat globals at once
#endif
// after <lights_fragment_end>
#ifdef USE_CLEARCOAT
  clearcoatSpecularIndirect *= k;        // reachable, they are file-scope
  clearcoatSpecularDirect   *= k;
#endif
```

Worth grepping the material dir for `reflectedLight` and cross-checking against
`clearcoat|sheen|transmission|iridescence` on the same material. Measured
effect here: gating the coat to the cornea and cutting its env term took the
delivered sclera's over-1.3x-cheek pixel count from 352 to 332 on its own — i.e.
it was *not* the biggest term either, which is only knowable by ablation.
