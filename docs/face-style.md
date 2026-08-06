# Face style brief — the stylisation call

Authored by Fable as art director, 2026-08-05. Successor to
`docs/face-direction.md`, which measured the failures; this brief chooses the
style that makes them unrepeatable. Everything face-direction.md measured
stands — the lid arithmetic, sclera at 1.7x skin, paint-not-bone gauntness,
hair at 1.5-1.6x — and is not re-litigated here. Sources verified against
`src/entities/material/{Skin,Eyes,Hair,Detail,FaceMap}.ts` (FaceMap read in its
in-flight state), `src/capture/Shots.ts`, and `shots/faces/closeup.png`.

Two facts drive every call below:

- **The distance audit.** The celebration cut at 12 m (~33 px head) is the
  closest camera that exists in gameplay; ~95% of play is 15-25 px heads on
  the tele broadcast. The 400 px closeup survives only as a hero portrait —
  player cards, replays, marketing. Six rounds tuned a portrait no player sees
  during play. We keep the portrait; we stop letting it drive the pipeline.
- **The valley runs on realism.** Atypical proportion and procedural
  imperfection disturb in proportion to how photoreal the surface claims to
  be; a more stylised, less detailed face tolerates far more before reading
  eerie. Our surface has been claiming FIFA and delivering mannequin. Pull the
  claim back and the same geometry stops being creepy.

## 1. The target: painted-plane naturalism (not Overwatch)

The proposal on the table was Overwatch/Valorant stylised realism. **Half
right.** Adopt their *method* — chiselled planes, "say it, or don't",
simplified material response, half-Lambert-derived band control — and refuse
their *proportion push and palette*. The distinction matters:

Overwatch and Valorant are hero shooters. Their faces are brand assets:
hand-sculpted, one per character, proportion-pushed so a silhouette identifies
a hero in 100 ms. We are a sports broadcast. Art-direction.md already fixed the
fantasy — "summer-evening club final, first TV deal", "club players, not
supersoldiers" — so the face must read *athlete*: generic, weathered, one of
fourteen. Our roster is procedural; we cannot hand-tune a proportion push per
head, and we do not need one — at 15-33 px identity comes from kit, skin tone
and hair mass, never from a jaw angle. The research licenses distortion on
stylised faces; it does not oblige it. We take the tolerance, not the
distortion.

**The target, named:** keep the anthropometric skull (face-direction.md froze
it) and move ALL stylisation into shading and paint. References, in order:

- **Sifu** — realistic proportions, aggressively planar faces, flat colour
  fields, zero pore detail, and it holds up under exactly our kind of
  naturalistic raking light. The closest existing thing to "club athlete,
  painted planes".
- **Arcane** (method, not medium) — the painted albedo does the modelling:
  light does value, paint does form. Directly relevant because BRIEF.md rule 2
  means our albedo is painted in code, and `FaceMap.ts` is already that
  painting.
- **Valorant** — the shading discipline: materials obvious but simplified,
  capped saturation and value range, half-Lambert extended with separate
  highlight / mid tone / core shadow control. We adopt that model in §3.
- **Overwatch** — the editing rule only: "say it, or don't". A form that ships
  gets real presence in silhouette or value at a camera that actually exists;
  a form that can't is deleted. §4 is that rule applied.

On a 0-100 axis where TF2 is 20 and a FIFA head-scan is 100, we sit at
**65-70**: true proportions, real golden-hour PBR per art-direction.md §3, but
the surface complexity of a painting, not a scan. More naturalistic than the
hero shooters, far less detailed than rounds 1-6 attempted.

Is the whole strategy misguided? No — it is the exit face-direction.md §5
already named: "commit to a cleaner, more graphic stylisation of the face...
which costs nothing against rule 2." The distance audit converts that fallback
into the plan. What would be misguided is continuing to chase scan-grade
realism for a camera that exists only in the pause menu, with procedural noise
standing in for scanned detail — that is the valley's exact recipe:
near-photoreal claim, sub-photoreal delivery.

Palette discipline carries over from art-direction.md §2 unchanged: skin stays
H 20-35°, S 20-35%; the face never competes with the two kits and the disc.
Stylisation here means fewer, cleaner forms — never brighter or more saturated
ones.

## 2. Plane structure: chisel in normals and paint, never in vertices

Face-direction.md verified the proportion ladder and banned resculpting; the
ban stands. "Chiselling the planes" therefore means exactly two mechanisms,
each with a budget:

1. **Normal hardening (shading change).** At a named plane break, compress the
   vertex-normal rotation from the current smooth blend (~20-30 mm wide) to
   **≤ 10 mm**, editing normals only — vertex positions untouched, silhouette
   byte-identical. This is the toon-modeller's edited-normal trick, applied as
   a post-pass on the head's vertex normals in `rig/Head.ts`, keyed to the
   same landmark frame the FaceMap bake reads. It is what makes a plane
   "said" under a raking key.
2. **Painted value step (albedo change).** A 3-8% albedo value step across the
   break line, blended over 4-8 mm, so the plane survives flat light, mips,
   and the far tier where normal detail averages away.

Five plane breaks get said. Nothing else does.

| Plane break | Mechanism | Numbers |
|---|---|---|
| Temporal ridge (forehead front → temple) | normals + paint | front plane ≈ 2/3 forehead width; temple plane rotated back 60-70° from frontal; normal blend ≤ 10 mm; the existing analytic temple term in Skin.ts becomes this step, 0.95x on the temple side |
| Brow bar underside (orbital band top) | paint + existing sculpt | the dark band of face-direction.md §1; band mean ≤ 0.85x cheek — the FaceMap G channel IS this plane |
| Zygomatic arch (malar top-plane → submalar) | normals + paint | breaks along the arch from ear to ~15 mm lateral of the nose wing; submalar side painted 0.90x; this replaces the deleted third copy of the hollow — the sculpted hollow stays halved per face-direction.md, and FaceMap.ts has already deleted its painted copy. Do not restore either |
| Nose side-planes (dorsum → sides) | paint only | side planes 0.85-0.90x of dorsum; the sculpt already carries the 40-55° side-plane angle; add NO geometry |
| Jaw line (side-plane → submandibular) | normals + paint | normal blend ≤ 10 mm along the mandible; below it only the *gated* 0.30 submandibular shadow from face-direction.md, never the old blanket 0.55 |

Explicitly SOFT (no hardening, no painted step): cheek ball, chin ball,
forehead centre, philtrum. The nasolabial fold stays what FaceMap.ts already
makes it — a single soft cavity Gaussian, not a break. A face that is all
plane breaks reads robotic; five breaks against soft volumes reads chiselled.

**The mouth is paint, full stop.** The head mesh runs ~4.9 mm row pitch at the
lip line against 1.5-4.5 mm feature Gaussians — sub-Nyquist in geometry at any
LOD — so the muzzle gets zero sculpt and zero normal work. FaceMap.ts already
implements the right answer and this brief endorses it as the pattern for the
whole style: the oral line at weight 0.62, ~2.5 texels wide, keyed to the
athlete's own mouth width (the strongest single term in the map); the
vermilion as one overlapping 18 mm mass rather than two thin ribbons, targeted
at 0.70-0.80x philtrum; the upper lip painted darker than the lower (it faces
away from top-light). Paint carries what geometry cannot afford — the Arcane
lesson, already in the codebase.

## 3. Shading model: the wrap exists — add the band control

Skin.ts already ships a normalised per-channel wrapped diffuse
(`RE_Direct_Skin`, Skin.ts:615-645): `diff = (NdotL + w) / (1 + w)²` with
`gWrap = vec3(0.30, 0.16, 0.10)` (Skin.ts:540), red wrapping furthest. So the
question is not whether to adopt half-Lambert — we have it — but whether to
widen it and add Valorant's three-band brightness control on top. **Yes to
both, on athlete skin and hair only.** Kits, turf, world: untouched, standard
PBR; the stadium stays honest broadcast.

- **Wrap width: raise `gWrap` to `vec3(0.42, 0.33, 0.26)`** (mean ≈ 0.34,
  R:B spread 1.6:1 — respecting Skin.ts's own finding that a 3:1 spread reads
  red, not warm). Keep the existing `mix(1.0, 0.62, expo*0.5)` exposure
  attenuation. Rationale: once form lives in albedo (§2, §4), the shadow side
  must stay legible enough to show the paint; 0.19 mean wrap crushes it,
  half-Lambert's 0.5 flattens golden-hour form. 0.34 is the seam.
- **Three bands on the wrapped factor t (per-pixel mean of `diff`), remapped
  before `BRDF_Lambert`:**

  | Band | Range of t | Gain | Purpose |
  |---|---|---|---|
  | Core shadow | t < 0.33 | 0.62, output floor 0.18 | shadow holds colour; never crushes, never hue-inverts |
  | Mid tone | 0.33 ≤ t < 0.80 | 1.00 | the face lives here; linear, no remap |
  | Highlight | t ≥ 0.80 | 0.90, output ceiling 0.97 pre-specular | the golden key rakes without blowing skin |

- **Knees:** smoothstep over ±0.06 of t at both boundaries (0.27-0.39,
  0.74-0.86). Hard steps posterise at 400 px; ±0.06 keeps a *visible* band
  structure at portrait range and melts into smooth gradient by 30 px — the
  two-distance behaviour of §5, for free.
- **Shadow tint:** one global term — core-shadow band multiplied by
  `(1.03, 0.99, 0.95)`. This **retires the hemisphere tint pair entirely**
  (face-direction.md halved it; the band tint replaces it). One tint, both
  sides of every face, every seed. The salmon-vs-teal split becomes
  unconstructible.
- Night towers use the same wrap, so the four-shadow invariant
  (art-direction.md §3) keeps its shadow shapes while faces stop crushing.

**The orbital-band polarity problem under wrap.** Half-Lambert's whole job is
lifting shadow — and the one region we need dark is the socket, which a wider
wrap will lift straight back toward mannequin. The correction is structural,
not tuned: **the band's darkness lives in terms the ramp cannot touch.**
Skin.ts already multiplies the FaceMap cavity into albedo
(`skin *= 1.0 - 0.26 * cavity`, Skin.ts:528) precisely so the ratio "holds
whether that side of the face is lit or not" — its own comment. Extend that
contract:

1. The FaceMap G orbital frame + R cavity must together put the baked band
   (brow to lower lid, canthus to canthus) at **0.78-0.85x** adjacent-cheek
   albedo — dark at noon, at golden hour, and at 25 px, because it is painted
   dark.
2. A baked socket-AO multiplier over the same band, applied post-ramp at
   0.85-0.92, portrait tier only (§5) — restoring the occlusion the wrap
   forfeits.
3. Every sclera/iris/catchlight cap of face-direction.md §2 stands unchanged:
   sclera 0.9-1.1x cheek, iris the middle value at 0.45-0.65x, one ≤ 3 px
   catchlight.

Net: check #4 (orbital band ≤ 0.85x cheek) stops being a lighting outcome and
becomes a construction guarantee.

## 4. What dies — the "say it, or don't" audit

Thesis: **a shorter list of stronger forms.** Every form either has presence
at a camera that exists — portrait (400 px), celebration (33 px), tele
(15-25 px) — or it is deleted. "Frozen" (face-direction.md's verdict on the
sub-pixel physics) upgrades to "deleted" wherever the stylisation makes a form
a liability rather than merely invisible.

### The albedo lobes: ~30 unfiltered analytics → 25 named forms, list closed

FaceMap.ts has already executed the core of this audit, and its architecture
is the right one: the fine front-of-face structure moved into a per-athlete
raster **with a mip chain** (R cavity, G orbital frame, B signed lip,
A perfusion — 15 named forms), while 7 broad C1-by-construction terms stay
analytic in Skin.ts (submandibular, temple, ear gutter, scalp, beard zone,
sweat zone, roughness field). Add §2's three new plane steps (zygomatic, nose
side, upper-lip) and the total face-paint budget is **25 named forms. The list
is closed** — adding a form requires deleting one, in this document.

Confirmed dead, by name (most already executed in the in-flight FaceMap.ts —
listed so no round ever resurrects them):
- **The painted submalar hollow** — third copy of a hollow that exists in
  sculpt and tint. FaceMap.ts deleted it; the zygomatic plane step (§2) is its
  only successor. "Gaunt" dies here.
- **The tear-trough / flush / crease stack** — the bleeding-tear-duct
  machine. Trough survives only at FaceMap's reduced 0.18 weight with the
  malar perfusion lobe moved off its centre; the no-shared-centres rule is now
  policy for all 25 forms.
- **Per-brow noise asymmetry and 1.3 mm brow cells** — replaced by 2.0 mm
  cells, solid core, breakup only in the outer quarter. A brow is a shape, not
  stubble.
- **The three-Gaussian lash/lid/splay stack** — now one profile. Broken
  lashes read inside 1.5 m; no camera lives there.
- **The drawn lip line in the colour channel and full-strength lipBorder** —
  the "lip liner" note. The pale roll survives only at FaceMap's halved
  weight, and its Skin.ts lift caps at **+8%** (`1.0 + 0.16 * lipBorder` →
  `0.08`): a roll, never a ring.
- **The hemisphere tint pair** — retired by §3's single shadow tint.
- **The chest tan bib / tan step** — condemned in face-direction.md; the tan
  story lives at the sleeve hem only. Confirm deletion.

### Detail.ts on the face: the pore layer dies

The shared micro-detail maps stay for kit knits and body — but **on the head,
every micro claim is retired**:
- Pore normals: `poreN` and the `poreTri` fine octave contribute **zero** to
  the face normal (Skin.ts:590-596). At 33 px they alias; at 400 px they are
  the photoreal claim we are withdrawing.
- Micro roughness modulation `rgh *= mix(0.84, 1.16, micro)` and the
  `(aux.r - 0.5) * 0.05` jitter (Skin.ts:577-578): **off for the face**. The
  broken-highlight "islands" cue is a scan-realism cue; a stylised face wants
  one clean, well-placed highlight. The *broad* roughness zoning (oily
  forehead/nose vs matte malar, Skin.ts:560-566) is exactly "materials obvious
  but simplified" — it stays.
- Wrinkle normal gradients, crow's feet, forehead micro-wrinkles, philtrum
  columns, vermilion displacement/relief: **deleted**. Skin.ts's own header
  admits the vermilion relief "has never been seen". Believe it, then act
  on it.
- Brow/stubble bump survives as the *single* retained micro-normal term, at
  half amplitude (`hairBump * 1.6` → `0.8`) — enough to keep painted brows
  from reading as decals under the raking key, no more. Stubble itself is the
  broad beard-zone value/roughness shift, never per-hair noise.
- Countable outcome for all of the above: any 16x16 px patch of lit cheek at
  portrait framing has luminance σ ≤ 0.02.

### Eyes.ts / Tone.ts: the physiology dies, the graphic survives

Delete the iris crypts (Eyes.ts:148-158), the refracted parallax
(Eyes.ts:184-189), and the stroma fibre detail. The eye becomes a
**four-value graphic**: sclera 0.9-1.1x cheek; iris body one flat midtone,
0.45-0.65x cheek; limbal ring ≤ 20% of iris radius; pupil ≤ 0.15x cheek; one
catchlight ≤ 3 px, allowed to clip. After the Head.ts lid fix (unchanged from
face-direction.md, still lands first) the visible iris is ~14-16 px at
portrait framing — a flat disc with a limbal ring is indistinguishable from
the crypt model there, at none of the risk. Sifu and Valorant ship flat irises
under bigger cameras than ours. The clearcoat (Eyes.ts:76-78) is the
catchlight and survives **on the cornea only, portrait tier only** (§5);
scleral clearcoat is dead, not gated.

### Hair.ts: lobes become portrait-only; the field gets two tones and a rim

Hair.ts is already "Marschner reduced to the two terms that actually pay"
(its own header): R + TRT, GGX disabled. The audit's ruling by tier:
- **Portrait tier: R + TRT survive.** Two lobes is already the minimum that
  avoids wet-plastic grey, and at 400 px the warm TRT sheen has presence.
  Freeze stands; the TRT shift tuning era is over.
- **Field tier (every gameplay camera): both lobes die.** An anisotropic
  specular band on a 20 px head is a white-stripe artifact generator. Field
  hair is: base tone + core-shadow tone on the §3 wrap, plus the **backlit
  rim, which stays in both tiers** — it earns silhouette presence in every
  golden-hour frame and is the one hair feature the shot list rewards.
- Per-strand grey variation: deleted. Clump-scale value modulation (the
  ≥ 20% at 10-15 px lock scale that face-direction.md demands) moves into
  painted macro value, where it mips honestly.
- Every macro requirement of face-direction.md §2 remains binding: cap ≤ 1.5x
  face, fringe erosion 4-10 px with no 8 px notch, no < 6 px striping,
  hairline step ≥ 15% at endzone.

### The rule going forward

Any PR adding a face feature must name the camera that can count it:
portrait, celebration, or tele. A feature countable at none is rejected at
review. That is "say it, or don't", made enforceable.

## 5. The two-distance contract

The audit's gift: **no real camera lives between 33 px and the portrait.**
The regimes never share a frame, so they can get different *materials* with no
visible pop. The answer is not separate face art — one FaceMap albedo serves
both, and FaceMap.ts's mip chain is the whole mechanism (its header is right:
a raster's area-mean is the only thing that holds a value relationship across
a 10x change in head size). It is **two material tiers** bound to the existing
PlayerRig LOD system:

**Tier P — portrait. Camera ≤ 3 m: pause/replay/player-card tableaux only.**
Full §3 ramp with knees; normal-hardened plane breaks; baked socket AO;
four-value eye with corneal clearcoat catchlight; hair R + TRT; the full
face-direction.md closeup check suite.

**Tier F — field. Every gameplay camera, 12 m and beyond.**
- Same FaceMap albedo, mipped. The §4 budget exists so nothing in the map
  aliases: no painted feature except the catchlight is under 3 px at portrait
  scale, and the catchlight is a Tier P specular term, not a map term.
- **Eye specular = 0** (clearcoat off, GGX off). Globes keep their geometry;
  the material renders matte, values from the painted aperture band. The
  glowing-white-dot failure becomes unconstructible at the exact distances
  where it lived.
- Hair lobes off; two tones + rim (§4).
- Ramp simplifies to wrap + band gains, no knees (sub-pixel at 33 px anyway).
- What carries the likeness: skin field, hair mass with a hairline step, one
  dark eye-and-brow bar, one dark mouth line. Four marks, all albedo, immune
  to whatever the lighting schedule does.

Where the tiers conflict, rulings:
- *Band darkness.* The portrait wants the orbital band subtle (0.78-0.85x);
  25 px legibility wants darker. Ruling: the band **core** (lash line to brow
  underside, middle 60% of band height) may run 0.70x; the feathered edges
  bring the band *mean* to 0.78-0.85x. Tele sees the core (a dark bar that
  reads); the portrait sees the gradient (no raccoon).
- *Specularity.* The portrait needs the catchlight; the field must never see
  eye spec. Ruled above: spec is a tier term, not a map term.
- *Plane breaks.* Normal hardening is invisible below ~60 px heads and costs
  nothing there; ships in both tiers.
- *The switch.* Tier switch binds to the existing LOD transition and MUST sit
  nearer than 12 m, so no gameplay camera can ever witness it. Celebration at
  12 m is already Tier F — which means the closest shot any player sees in
  play is validated against the *simple* face, not the hero one. That is the
  correct priority, stated once and now enforceable.

## 6. Acceptance numbers

Countable off `node tools/capture.mjs closeup endzone` plus a new
**celebration** framing (12 m, fov 24° — it is absent from
`src/capture/Shots.ts` and is now the most important real camera; add it).
Two seeds minimum, one dark-haired, one blond — blond-on-fair remains the
worst case and the case in frame today.

### Fate of face-direction.md's thirteen checks

| # | Check | Fate |
|---|---|---|
| 1 | ≤ 12 px ≥ 1.3x cheek per aperture | **Survives, tightened to ≤ 8 px** — the flat iris removes the speckle sources |
| 2 | Zero sclera above iris top | **Survives** unchanged |
| 3 | Iris + pupil ≥ 40% of aperture | **Survives** unchanged |
| 4 | Orbital band ≤ 0.85x cheek | **Survives**, now construction-guaranteed by baked albedo (§3); measure anyway |
| 5 | Vermilion 0.70-0.80x philtrum; ≥ 30 px mouth line | **Survives** unchanged; FaceMap's widened vermilion mass is the mechanism |
| 6 | No boundary > 1.25x adjacent-mean | **Survives** unchanged; the 25-form budget should pass it with margin |
| 7 | Hair 0.8-1.3x forehead; no < 6 px striping; fringe 4-10 px | **Survives**; the striping clause becomes a regression guard once field-tier lobes die |
| 8 | Brows ≥ 70% interior coverage, within 20% | **Superseded → ≥ 85%**: brows are now solid painted shapes broken only in the outer quarter (FaceMap already builds this) |
| 9 | No canthus drip | **Survives as regression guard** — construction-guaranteed by the no-shared-centres rule |
| 10 | No background through ear silhouette | **Survives** unchanged |
| 11 | Endzone: zero face px > 1.4x face mean | **Survives — now the most important check in the suite** |
| 12 | Endzone: eye band darker than face mean | **Survives, sharpened**: band 0.6-0.8x face mean over a 2-3 px bar |
| 13 | Endzone: hairline step ≥ 15% | **Survives** unchanged |

Void: none. All thirteen were value-relationship checks, which is exactly why
they survive a restyle intact. Checks 4, 7 (striping) and 9 downgrade from
"the fix" to regression guards because the style deletes their failure
mechanism outright.

### New checks introduced by this brief

**Portrait (Tier P, ~400 px head), off `closeup`:**

14. Band structure exists: along a 60 px scanline from lit cheek across the
    terminator, at least one and at most two luminance steps of 8-20%, each
    completing within ≤ 10 px (the §3 knees) — zero steps is the old smooth
    mannequin, three-plus is posterisation.
15. Core-shadow floor: darkest skin pixel on the shadow-side cheek (excluding
    nostril and mouth interior) ≥ 0.40x lit-cheek mean, and shadow-side hue
    within 8° of lit-side hue. Salmon/teal stays dead.
16. Planes said: a horizontal scanline at brow height crosses an 8-15%
    luminance step completing within ≤ 6 px at the temporal ridge; likewise at
    the zygomatic arch on a cheek-height scanline.
17. Detail kill: every 16x16 px patch of lit cheek has luminance σ ≤ 0.02.
18. Highlight ceiling: no skin pixel ≥ 0.97 pre-grade; the key rakes, never
    clips.

**Celebration (Tier F, ~33 px head) — the new capture, three checks:**

19. Eye region max pixel ≤ 1.15x face mean — the Tier F spec-kill verified at
    the nearest camera any player actually gets.
20. The mouth reads: a ≥ 2 px dark run (≤ 0.85x face mean) at mouth height.
21. Four-mark quantisation: face pixels cluster to ≤ 4 luminance modes (skin,
    hair, orbital bar, mouth line) with ≥ 85% of pixels within 0.05 L of a
    mode — the countable form of "reads as a face, not an ovoid, at 33 px".

### Sequencing

Unchanged from face-direction.md at the head: **Head.ts lids first**, Eyes.ts
re-levels against them. Then in parallel: FaceMap/Skin deletions and plane
steps (§2, §4), the §3 band control, Hair simplification. The tier split (§5)
lands **last** — it is a material binding, not new art, and both tiers must
already pass their checks at their own distances before the switch exists to
hide anything.
