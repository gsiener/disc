---
title: 'A DEBUG_MASK hatch capture blooms about a pixel past the geometry, so a stencil taken from it counts lid-margin skin as aperture and over-reports every hot-pixel test'
severity: 'minor'
---

## The technique and its edge

Section 4 of the face brief is countable only if you can separate sclera, iris
and pupil in a shaded frame, which by value you cannot. `Eyes.ts`'s
`DEBUG_MASK` solves it: capture once with the three regions painted flat, use
that frame as a pixel-aligned stencil over the shaded one. It works, and it is
the only reason this round has numbers.

But the mask capture goes through the same composer as everything else — bloom,
grade, FXAA — so the flat hatch bleeds roughly one pixel outward. Measured at
the aperture edge (mask vs shaded, same pixel, x increasing across the boundary):

```
x878  mask (190,199,246)  shaded (103, 94, 87)   <- classified sclera, IS sclera
x879  mask (191,200,246)  shaded (115,105, 95)   <- classified sclera, IS sclera
x880  mask ( 97,102,127)  shaded ( 61, 55, 48)   <- classified sclera, IS SKIN
x881  mask ( 47, 41, 32)  shaded ( 47, 41, 32)   <- outside, identical
```

The lid margin is the brightest skin on the whole face, so that one-pixel ring is
exactly the population the 'pixels over 1.3x cheek' test is counting. On the
final build the un-eroded count is 10 and 13 per eye; eroded by one pixel it is
8 and 2. Same frame, same shader.

## What to do

Erode the stencil by one pixel before using it, and report both numbers — never
only the flattering one. `tools/_eyecheck.py` now emits
`pxOver1_3xCheek` and `pxOver1_3xCheekEroded` side by side for this reason.

Note the residue is a genuine finding either way: the pixels the erosion removes
are the lid margin, which is `Skin.ts`'s section-2 directive ('lash line,
lid-margin shadow and brow as one connected mass'), so the un-eroded number
should fall on its own when that lands.
