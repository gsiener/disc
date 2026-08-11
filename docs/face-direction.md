# Face direction brief

Authored by Fable as art director, 2026-08-05, after reading
`shots/faces/{closeup,endzone,layout}.png` at pixel level (with 6x crops of the
eye band and two mid-distance heads) and all five face source files in full.
Every number below was measured off the delivered PNGs or computed from
constants in those files.

Baseline for all acceptance numbers is the delivered closeup: head spans
~409 px, ~1.74 px/mm, eye apertures ~36 px wide as rendered.

## 0. What the pixels actually say

<!-- See .agents/friction-log/20260806025738-docs-face-direction/ — these numbers are sRGB-ENCODED luminance; a tool that gamma-decodes before ratioing (as _eyelum.mjs did) will disagree with every threshold below. -->
Mean luminance, sRGB 0-1, off `shots/faces/closeup.png`:

| Region | L | Note |
|---|---|---|
| Sclera, both eyes | 0.41 mean, **0.95 peak** | brightest material on the face |
| Adjacent lit skin (forehead/cheek) | 0.23-0.24 | |
| Shadow-side cheek | 0.34 at RGB (109, 82, 72) | *brighter and much redder* than the lit side |
| Hair cap | 0.35-0.38 | 1.5-1.6x the face it sits on |
| Neck | 0.235 | darker than the chin above it |
| Chest bib inside collar | **0.552** | 2.35x the neck, hard boundary |
| Lips | 0.22 vs ~0.24 surround | delta 8% - under the mottle noise, i.e. invisible |
| Ear | 0.22 | value is fine; the problem is shape |

At the eye, blown up 6x: the iris midtone is ~10 px of a 36 px aperture. Iris
plus pupil cover roughly **18% of the visible aperture area**. On a relaxed
human eye seen front-on the figure is 45-50%, because the upper lid crosses the
iris and the aperture is shorter than the iris is tall.

This is not a tuning accident. It is guaranteed by `Head.ts`:
`apU = er*(0.34 + 0.34*eyeOpen)` puts the aperture top 5.3-7.8 mm above the
pupil axis across the roster's `eyeOpen` range [0.30, 0.92], while the iris top
sits at 5.7-6.3 mm (`irisR` 0.478-0.528 of a 12 mm globe). **The most relaxed
athlete the parameter space can produce has the lid tangent to the iris;
everyone else shows white above it.** Sclera visible above the iris is the
hardwired human startle display, and viewers read it pre-attentively.

That is the terror, in one line of arithmetic.

### Corrections to the integrator's read

- It is **not** "tiny pupils". `irisR` is life-size (11.5-12.7 mm). The iris
  *reads* small because nothing covers it so the aperture dwarfs it, the limbal
  ring eats its outer 20%, and the whole iris renders near-black so iris and
  pupil fuse into one dark bead. The eye is a two-value object -- white ball,
  dark dot -- when it should be three: sclera ~ skin, iris a midtone, pupil dark.
- "Gaunt" is mostly **paint, not bone**. The proportion ladder in `Head.ts` is
  anthropometric and checks out. What reads gaunt is triple-punishment of the
  same concavities: a 6.3 mm sculpted submalar hollow, plus a cavity lobe, plus
  a *flush* lobe painting the same area red-brown, plus the hemisphere tint
  warming shadows. The shadow side is simultaneously darker, redder and
  hue-inverted against the lit side -- that reads as injury or grime.
  **Do not resculpt the skull.**

### Missed entirely

1. A giant specular streak across the top of each globe -- the clearcoat
   catchlight smeared over about a quarter of the ball, merging with the sclera.
   The "wet dot" has become a "wet bar".
2. A dark red drip-shaped artifact under the left inner canthus (tear-trough
   cavity + flush + crease coinciding) that reads as a bleeding tear duct.
3. Brow asymmetry: the left brow is a clean arc, the right dissolves into
   speckle. The brow noise cell is ~1.3 mm ~ 2 px at this framing, right at the
   aliasing floor.
4. **At endzone range the only facial feature that survives is a glowing white
   eye-dot on an otherwise featureless ovoid.** The value polarity of the orbit
   is inverted at *every* distance: brightest where a human is darkest.

## 1. The one thing

**The orbital region renders light; on a human under any top-light it is dark.**

Brow bar, lid shadow, lashes and socket form one dark band, with the sclera
*inside it* at roughly skin luminance, an iris midtone, and one small clipped
catchlight. Our render inverts every term: sclera at 1.7x skin mean (4x at
peak), no lid coverage, black iris, quarter-globe specular smear -- and at 20 m
it degenerates to a white glowing dot.

Fix the polarity of this one band and the closeup flips from terror to focus and
the endzone heads stop being mannequins, even if nothing else ships. Fix
everything else and leave this, and round 7 fails like rounds 1-6.

The rule, statable and testable at any framing: **mean luminance of the orbital
band (brow to lower lid, canthus to canthus) <= 0.85x the cheek below it; within
the band, no pixel above 1.3x cheek mean except one catchlight per eye.**

## 2. Directives, per file

### rig/Head.ts -- the lids. This lands FIRST; Eyes.ts re-levels against it.

- Re-map the aperture so the upper lid **always covers 1.5-2.5 mm of the iris**:
  `apU = er*(0.26 + 0.10*eyeOpen)` (aperture top 3.1-4.3 mm; iris top ~5.9 mm).
  The current mapping's floor is a stare and its ceiling is panic; the whole
  range must live inside "awake, relaxed, focused".
- Lower lid to the lower limbus: `apD = er*(0.44 + 0.05*eyeOpen)` (5.3-5.9 mm).
  Total aperture height lands 8.4-10.2 mm against a 29 mm width, which is
  anatomical, and the pupil correctly sits above the aperture's vertical
  midpoint. Keep the canthal tilt and hooding. Note the globe-placement solve
  samples the lower margin (`my = -1.15*apD`) -- re-verify the corneal apex
  contract after the change.
- Halve the submalar hollow: `0.058 + 0.048*(1-F.cheek)` -> `0.030 + 0.024*(1-F.cheek)`.
  The paint layer already carries that hollow twice.
- Close the ear-to-skull gap: background is visible *through* the head
  silhouette behind the ear, which is most of "detached flap". No daylight
  between helix root and skull at +/-40 degrees yaw.
- Touch nothing else. The proportion ladder, nose, mouth sculpt and funnel are
  right.

### material/Eyes.ts -- three values and one dot

- Sclera, rendered, must land **0.9-1.1x the adjacent upper-cheek mean**
  (currently 1.7x), max non-catchlight pixel <= 1.3x. The 0.315 albedo is not
  the problem -- the specular is. Gate the clearcoat to the cornea: on sclera,
  clearcoat contribution ~0, relying on the existing roughness ramp. The tear
  film on exposed sclera is real but it is not a mirror.
- **One catchlight per eye, <= 3 px at closeup framing** (a real 0.5-1 mm
  catchlight is 1-2 px at 1.74 px/mm), allowed to clip to 1.0, upper quadrant of
  the iris. Everything else on the globe obeys the 1.3x cap.
- The iris must be the middle value: iris midtone mean **0.45-0.65x cheek mean**,
  pupil <= 0.15x. If the `Tone.ts` stroma cannot reach that, raise the
  pupillary-zone / fibre gain -- at 10-16 px nobody sees crypts, they see the
  ring's mean. **Do not touch `irisR`.**
- `DEBUG_MASK` ships 0. Before it does, use it: capture once, count pixels, and
  report "iris+pupil = N% of aperture" in the hand-off. Target >= 40% after the
  Head.ts lids land.
- Freeze the refraction, crypts and fibre model. They are done and sub-pixel.

### material/Skin.ts -- subtraction, not addition

The file has ~30 analytic masks. **No new lobes.**

- Strengthen the continuous dark frame of the eye: lash line, lid-margin shadow
  and brow as one connected mass, so at endzone range (head ~25 px) the eye band
  is a 2-3 px bar at 0.6-0.8x face mean. This is the term that replaces the
  glowing dot at distance.
- Brows solid through the middle, broken only in the outer quarter. Noise cell
  >= 3 px at closeup (raise the 88/unit cross-arch rate's cell to >= 1.7 mm, or
  clamp the threshold so the core never dissolves). Both brows within 20% of
  each other's filled fraction.
- Decouple the patch stack: no flush lobe may share a centre with a cavity lobe.
  Halve the cheek flush lobe (0.42 -> 0.20); halve the hemisphere tint chroma
  ((1.12,1.05,0.84)/(0.90,0.97,1.14) -> (1.06,1.02,0.92)/(0.95,0.99,1.07)).
  The modelling stays; the salmon-vs-teal face split goes.
- The tan bib: across any skin boundary (collar, wrist, hairline), adjacent
  8x8 px means must differ <= 1.25x (currently 2.35x at the collar). Either lift
  chest expo under the collar to ~0.5 or cut the tan mix 0.85 -> 0.55. The tan
  story lives at the sleeve hem, which the jersey shows; the jugular notch is
  not a hem.
- Neck: the blanket `pNeck * 0.55` cavity is why the neck is darker than the
  chin lighting it from above. Cap at 0.30 and gate it to the submandibular
  triangle. Acceptance: neck mean within 15% of chin mean.
- Mouth: colour is the only channel that survives, so spend it. Vermilion mean
  **0.70-0.80x the philtrum mean** (currently 0.92, invisible), R/G up 15-20% vs
  surround, lip gloss reduced (`rgh -= lips*0.24` -> `-0.10`; the lips currently
  mirror blue sky), and the pale `lipBorder` ring gated to sub-2 m or halved --
  right now it reads as lip liner.
- Kill the canthus drip: no connected dark region (< 0.6x cheek mean) hanging
  more than 4 px below the lower lid.

### material/Hair.ts -- boundary and mass, nothing else

The wig read is three defects: **value** (cap at 1.5x the face it sits on,
uniformly), **boundary** (a hard temple line plus a mangy front-notch where the
fringe erosion bit 25+ px deep and exposed pale scalp), and **pattern**
(periodic vertical corduroy at ~3-4 px pitch across the crown).

- Fringe: per-column erosion depth 4-10 px at closeup, no connected eroded
  region wider than 8 px, and no scalp pixel *above* the visible hairline
  brighter than face mean. The notch is worse than the ruled line it replaced.
- Macro value: across any 40 px horizontal run of the cap, luminance must vary
  >= 20% peak-to-trough at lock scale (10-15 px). No periodic striping at < 6 px
  pitch over more than 20% of the cap, at any seed.
- Endzone: a hairline must exist at 25 px -- a scanline down the forehead
  crosses a >= 15% luminance step at the hairline on every seed. The gold
  player's head currently has none: skin-cap, no boundary, bathing-cap read.
- Freeze the Marschner lobes, the backlit halo and per-strand greys. The fibre
  optics are already past what any framing in the shot list rewards. Every hour
  this round goes to silhouette, boundary and macro value.

## 3. Stop doing

1. **Stop refining sub-pixel physics.** Iris crypts, refracted parallax, TRT
   shift tuning, 0.3 mm crow's feet, vermilion displacement, philtrum columns:
   all correct, all invisible, all frozen. `Skin.ts`'s own header admits the
   vermilion relief "has never been seen". Believe it.
2. **Stop adding analytic albedo lobes.** Every new lobe is a new patch
   boundary, and patch boundaries are the second-worst thing in the frame.
   This round's skin work is subtraction.
3. Turn off or fence: the chest tan step, the `lipBorder` ring beyond 2 m, the
   blanket neck cavity, the scleral clearcoat. `DEBUG_MASK` and `?skindbg` ship
   dark.
4. Stop letting "correct" stand in for "visible". The invisibility rule for this
   round: **if your diff does not move one of the section 4 numbers, it does not
   ship.**

## 4. How we know it worked

All countable off two capture commands (`node tools/capture.mjs closeup endzone`,
then read the PNGs). A ~30-line Python check over the two PNGs covers everything
below; the boxes are fixed because the tableau is deterministic.

**Closeup:**
1. Pixels >= 1.3x cheek mean inside each eye aperture <= 12 (the catchlight;
   currently hundreds).
2. Zero sclera pixels above the iris top.
3. Iris + pupil >= 40% of aperture area (count via the mask hatch, then
   re-verify shaded).
4. Orbital band mean <= 0.85x cheek mean.
5. Vermilion 0.70-0.80x philtrum; mouth reads as a >= 30 px dark line.
6. No skin/skin or skin/hair boundary with adjacent-mean ratio > 1.25x.
7. Hair mean 0.8-1.3x same-side forehead; no < 6 px striping; fringe band
   4-10 px with no 8 px notch.
8. Both brows >= 70% interior coverage, within 20% of each other.
9. No dark drip below either canthus.
10. No background through the head silhouette at the ear.

**Endzone, any head >= 20 px:** zero face pixels > 1.4x face mean (no glowing
eye-dots -- this is the one that catches the polarity inversion at distance);
eye band darker than face mean; hairline step >= 15% present.

Run on at least two seeds, one dark-haired, one blond. Blond-on-fair is the
worst case and it is the case in frame today.

## 5. The zero-binary-assets constraint, answered plainly

It is **not** the root cause, and I will not hide behind it. Every failure in
these three PNGs is a *relationship* failure -- a coverage ratio, a luminance
ratio, a mask boundary -- and procedural code can hit relationships exactly;
that is the one thing it is best at.

What the constraint did do is shape the failure pattern. It seduced six rounds
into the physics that code is satisfying to write (Marschner lobes, Jacques
chromophores, diffusion approximations) while the actual gaps were arithmetic a
portrait painter checks with a squint. The pipeline's physics is now *ahead* of
its value structure, which is exactly backwards.

If, after this round lands and the section 4 numbers all pass, the closeup still
reads mannequin -- then the decision to put to the user is not "buy a scanned
head", it is "commit to a cleaner, more graphic stylisation of the face", which
the art direction's "club players, not supersoldiers" already tolerates and
which costs nothing against rule 2. FIFA-grade photoreal faces at 400 px were
never reachable under this constraint at this team size; a focused, human,
*athletic* face absolutely is.

## Sequencing

`Head.ts` lids land **first** -- `Eyes.ts`'s levels were calibrated against the
old lidless aperture (its comments say so) and must re-check after coverage
arrives. Skin and Hair run in parallel throughout.

One note beyond the four files: the portrait tableau should converge the gaze on
the lens. Eye contact reads as focus; averted wide eyes read as startle, and
both irises are currently drifting off-camera. That is an Animator/tableau
half-day, not a face-file edit.
