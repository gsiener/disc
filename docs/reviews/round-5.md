# Blind visual review — round 5

Frames captured at `--q high`, 1920×1080, real GPU (ANGLE Metal, M1 Max). The
reviewer was not told what the project was, who built it, or on what budget, and
was asked first to guess the product tier from pixels alone.

## Result: 4.4 / 10 — INDIE (round 2 was 3.33 / PROTOTYPE)

| axis | score |
|---|---|
| lighting | 5 |
| materials | 4 |
| geometry | 4 |
| atmosphere | 6 |
| composition | 5 |
| characters | 3 |
| **overall** | **4** |

Blind guess:

> Competent commercial indie — with a character pipeline that drags it toward
> student project, and one shot (`night`) that is an engine tech demo wearing a
> stadium. […] a photographic renderer, a real stadium, a real HUD — pointed at a
> character asset that is not finished and a touchline that is placeholder.

What it credited: convincing crowd bokeh with real depth falloff, correct aerial
perspective, a believable cumulus bank, turf with real blade scatter and correct
chalk edge softness, and a scorebug with "better typography than several shipped
sports titles."

## The inversion of effort has moved, not gone

Round 2's unanimous criticism was an ambitious renderer drawing a placeholder
world with capsule players. That is retired — the athletes now have fitted kits,
woven normals, SDF chest numbers, per-athlete tone, athletic poses and correct
contact shadows. But:

> The effort has flipped ends. The world is now the strong asset and the
> character is now the weak one — and the shot list spends its most expensive,
> shallowest-DoF, most photographic framing on the least finished thing.
>
> `pushPerson()` builds every bench occupant, coach, observer and camera operator
> out of BOX, CYL6 and SPH primitives. **The featureless capsules did not get
> deleted. They moved to the touchline.**

## The core insight

> A lot of this work is correct but invisible: the iris shader cannot be seen
> because there are no eye bones; the mouth sculpt cannot be seen because there is
> no lip albedo; the hair fibre model cannot be seen because the alpha erosion is
> gated off at the framing that matters.

## Ranked defects

1. **No eye bones — CRITICAL.** `rig/Skeleton.ts` computes an `eyeY` measurement
   but has no eye joints; `Head.ts` skins both globes to the head bone, so the
   optical axis is welded to head-forward and can never converge. `Animator.ts`
   already computes a gaze target and uses it to yaw the head — which turns the
   head ~35° off camera in `closeup`, so the camera sees the globes
   near-tangentially as solid white almonds. Every line of refracted-parallax
   iris, trabecular fibre, limbal ring and catchlight work in `Eyes.ts` is
   invisible on the hero shot.
2. **Face cavity accumulator saturates — CRITICAL.** The orbital lobe in
   `Skin.ts` uses sigma 0.85 in `qq` units, which reaches most of the mid-face;
   summed with eight further lobes and clamped at 1.0 it darkens the whole front
   of the head 30–40% against the temple and scalp. The `smoothstep(0.10, 0.30, hz)`
   front gate then produces a visible terminator at a fixed surface angle. This is
   most of the "mask on a lighter skull" read.
3. **No mouth — SEVERE.** `Head.ts` sculpts cupid's bow, both vermilions, lip
   line, commissure pits and philtrum columns. Nothing changes the *albedo* over
   the vermilion, and colour is what survives at 90 px, not 1 mm of displacement.
4. **Sideline bodies are boxes — SEVERE.** ~30 box-figures in a readable band
   across the top third of `broadcast`.
5. **Hair is a moulded cap — SEVERE.** Alpha erosion is gated on grazing angle,
   so at a face-on crown the interior stays a solid dome. A head of hair has holes
   in the middle, not only at the edge.
6. **`night` is not a night frame — SEVERE.** The camera at `[-30, 11, 24]` has no
   mast in frame, so "bloom on rigs" is unachievable from that camera regardless
   of renderer. No specular kick on skin or turf, flat black sky, no glow dome.
7. **`closeup` cannot test what it exists to test — MODERATE.** 3.66 m at 42°
   puts a 234 mm head at 90 px in a 1080 frame. Stitching, weave, hair and eyes
   cannot be judged at all.
8. **Black specks across the turf** at 40–60 m — isolated sub-pixel blades 12%
   darker than the ground they sit on.
9. **Static cross-hatch dither** over every out-of-focus region — interleaved
   gradient noise with no temporal term, so it never averages out.
10. **Number kerning and cloth** — half an em between digits, chromatic fringe at
    `uCa: 0.55`, and a jersey with fine weave grain but zero fold structure.
