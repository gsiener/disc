---
title: 'The cheek reference box the whole brief ratios against swings 0.24 to 0.55 across 40 px of this face, so a hand-placed box moves the sclera verdict from fail to pass with no shader change'
severity: 'minor'
---

## The problem

Every acceptance number in section 2 and 4 of `docs/face-direction.md` is 'x the
cheek below it', and section 4 says 'the boxes are fixed because the tableau is
deterministic'. Deterministic it is; homogeneous it is not. Sixteen 16x14 boxes
under the viewer-right eye of the delivered closeup:

```
        x930   x940   x950   x960   x970
y274   0.323  0.268  0.242  0.307  0.545
y280   0.328  0.272  0.247  0.284  0.474
y286   0.315  0.272  0.261  0.275  0.416
y292   0.304  0.274  0.273  0.278  0.399
```

A 2.25x spread inside one cheek, because the lateral cheek turns into the key
and the infraorbital region does not. With my first hand-placed box the sclera
measured 0.77x cheek (fail); with a box 30 px to the left, 0.94x (pass). Same
PNG.

## What I did instead

Derive the box from the aperture stencil: the aperture's own x-span, in a 14 px
band starting 4 px below the aperture's lowest pixel. Mechanical, reproducible,
un-shoppable, and it follows the eye if a peer moves the head — which matters,
because entry `20260806011515-measured-numbers-in` is exactly 'measured numbers
in comments do not say which camera they were measured on, and the camera moved'.

`tools/_eyecheck.py` does this and prints the box it used with every result.

## Suggestion for the brief

Section 4 should specify the cheek box as a rule rather than as coordinates, for
the same reason it specifies ratios rather than values. Any agent grading their
own work against a box they placed themselves has a free parameter worth 25
percent of the answer.
