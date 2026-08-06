---
title: 'Three rounds blamed the sclera albedo for a brightness that was three fifths one un-occluded additive glow, because nobody had ever ablated a single term'
severity: 'major'
---

## The measurement that should have been made in round 1

`Eyes.ts` carried a 17-line comment stack recording `sclera` being walked down
0.50 -> 0.395 -> 0.315, each step justified against the delivered closeup, each
step failing. The face brief then told this round 'the 0.315 albedo is not the
problem — the specular is'. Both were wrong, and one capture each settles it.

Four captures of the same frozen tableau, one term zeroed at a time, measured
with `tools/_eyecheck.py` (sclera mean as a multiple of the cheek directly
below the aperture):

| build | sclera / cheek | px over 1.3x |
|---|---|---|
| delivered | 1.62 | 352 |
| minus the additive 'sss' glow | 0.94 | 38 |
| minus all specular AND the glow | 0.90 | 27 |
| direct diffuse only | 0.42 | 20 |

Decomposed: **glow +0.60x, indirect diffuse +0.48x, direct diffuse +0.42x, all
specular and clearcoat +0.04x.** The term everyone blamed was worth four
hundredths.

The glow was one line:

```glsl
float sss = (1.0 - limbus) * (0.45 + 0.55 * lidUp);
reflectedLight.indirectDiffuse += uSunColor * uSunGlow * 0.055 * sss * vec3(1.0, 0.86, 0.78);
```

proportional to `uSunGlow` and to nothing else: not shadowed, not occluded, not
attenuated by which side of the face it was on. That is why it hurt the
*shadow-side* eye worst — the delivered eye ratios were 1.62x on the dark side
and 1.58x on the lit side, against cheeks an octave apart.

It was also doing the white balance by accident. Its tint is (1.0, 0.86, 0.78);
with it removed the sclera came back at RGB (52, 63, 61) — green-dominant,
because the environment is a green pitch under a blue sky and a globe with a
clear line of sight to the environment picks up the environment.

## The generalisable bit

Ablation captures cost 2.5 minutes each on this rig and the tableau is frozen,
so a four-term decomposition is ten minutes. Six rounds of this file's history
are arguments about which term is guilty conducted entirely from source. Nobody
had ever run the ten minutes. Recommend the brief's section 4 get one more line:
*before you tune a level, ablate it.*
