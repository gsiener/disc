---
title: 'The hair cap''s value is 95% one un-occluded halo term, so six rounds of albedo and fibre work could not move it'
severity: 'minor'
---

Measured, not argued. `tools/capture.mjs closeup` + a probe that renders the same frame with the hair material's `color` forced to black (which removes direct diffuse AND the whole IBL path, since `diffuseColor = vec4(diffuse, opacity)`):

    closeup            hair mean L = 0.4317
    closeup_noalb      hair mean L = 0.4099   <- pigment entirely removed

The albedo path was **5%** of a blond cap's rendered luminance. The other 95% was the backlit halo in `Hair.ts`'s `lights_fragment_end` block:

    float bk = pow(clamp(dot(geometryViewDir, -Lv), 0.0, 1.0), 3.2);
    float edge = 1.0 - abs(dot(geometryNormal, geometryViewDir));
    reflectedLight.indirectDiffuse += uSunColor * uSunGlow * bk * (0.25 + 0.75 * edge) * gSheen * 0.18;

`geometryViewDir` is (0,0,1) in view space and `uSunView` is a per-frame constant, so **bk is one number over the entire head**. Multiplied by a floor of 0.25 it is a flat add on every hair fragment on every athlete — it does not vary with pigment, normal, uv, lock, strand or anything else the shader computes. That is exactly the art director's diagnosis ("the cap sits at 1.5-1.6x the luminance of the face beneath it, **uniformly**"), and it means every previous round's work on hair colour, per-strand scatter, clumping and Marschner lobes was landing on 5% of the pixels' value.

Why it kept surviving review: it is in the block the brief marks FROZEN ("freeze the Marschner lobes, the backlit halo and per-strand greys"), and it looks like a rim term. It is only a rim term if `edge` has no floor.

**Generalisable lesson.** Before tuning any material's colour, measure what fraction of its rendered value the albedo path actually carries. A one-line probe does it: flip `material.color` to black and re-render. If the frame barely changes, the albedo is not the lever and no amount of work on it will move a luminance-ratio acceptance number. I would guess this is worth running on skin, cloth and turf too — an additive term with a constant floor is invisible to code review and dominant in the frame.

Fix used here: `bk * edge * edge` with no floor and the gain raised, so the golden-hour rim is if anything stronger at the silhouette and gone in the middle of the cap. Cap mean went 1.92x -> 1.07x the same-side forehead on the shadow side and 1.24x -> 1.01x on the lit side, which is section 4.7's window.
