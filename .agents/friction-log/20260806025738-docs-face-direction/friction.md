---
title: 'docs/face-direction.md quotes luminance in sRGB-ENCODED space, but tools/_eyelum.mjs gamma-decodes before it ratios, so the shipped tool disagrees with the acceptance test'
severity: 'major'
---

## The two numbers

`docs/face-direction.md` section 0 says 'Mean luminance, sRGB 0-1' and gives one
worked example that settles it:

> Shadow-side cheek | 0.34 at RGB (109, 82, 72)

`0.2126R + 0.7152G + 0.0722B` on those bytes over 255:

| space | value |
|---|---|
| sRGB-encoded | **0.341** |
| gamma-decoded (linear) | 0.099 |

So every threshold in the brief — 1.3x cheek, 0.85x cheek, iris 0.45-0.65x,
sclera 0.9-1.1x — is a ratio **in the encoded space**, which is also the space a
painter squints in and the reason the brief's ratios are as tight as they are.

`tools/_eyelum.mjs`, which is the tool in the repo for exactly this measurement,
opens with 'Value structure of the orbital band, in DELIVERED pixels ... none of
them can be read off the shader source' — and then does

```js
const srgb = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (x, y) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
```

Linearising first stretches every ratio. On the delivered closeup the same
sclera reads **1.62x cheek encoded** and **2.76x linear**. Both are 'the sclera
is too bright'; only one of them is comparable with the number the brief will be
graded on, and a tuning pass driven by the linear number overshoots by roughly
the ratio of the two.

## Cost

An hour, and one whole misread: with the linear numbers the iris measured 0.97x
cheek and I nearly went looking for why a 'near-black' iris was rendering
brighter than its own cheek.

## Suggestion

Either fix `_eyelum.mjs` to match the brief, or put one line at the top of
section 0 saying the table is display-referred. `tools/_eyecheck.py` (added this
round) carries the note in its header, but two tools in the repo that answer the
same question differently is the actual friction.
