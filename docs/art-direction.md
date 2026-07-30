<!-- Written by a Fable 5 agent acting as art director, round 3. Preserved verbatim. -->

ART-DIRECTION BRIEF — 7v7 ULTIMATE (Round 3)
Sources verified against: shots/pause/{broadcast,stadium,turf}.png, shots/r3mid/night.png, and the files cited inline. Every number below is a target an engineer can assert against in the capture loop (`src/capture/Shots.ts` framings, `LightingSystem.lightReport()` for ratios).

---

## 1. The look: "Summer-evening club final, first TV deal"

Ultimate is an amateur-rooted, self-officiated outdoor sport played on real grass, in real weather, mostly in the second half of the day. Our identity is that sport the year it finally got a broadcast truck: **honest golden-hour naturalism** — low warm sun, long raking shadows, grass that shows a season of wear, a modest bowl that feels borrowed from a bigger sport, and athletes who look like club players, not augmented supersoldiers. The codebase already commits to this: `Solar.ts` tunes its arc so every named shot lands in raking light and calls it "long summer evening — golden shots." We are not choosing between broadcast realism and stylised drama; the style IS the hour. Everything warm, low-angle, and slightly hot in the highlights; nothing neon, nothing corporate-megastadium. The one deliberate departure from pure documentary: the disc and the two kits are allowed to sing. Everything else exists to make them sing.

Test for every future asset: "would this exist at a well-funded club championship in July?" The SUBSTITUTION box fails that test. A boom op does not.

## 2. Palette

Rule of the frame: **exactly three things may be saturated — the two kits and the disc.** Everything else lives under 50% HSV saturation so those three read. Currently turf, crowd, boards, and wear streaks all compete; nothing wins.

| Element | Target (sRGB, display-referred at h≈17.5) | Hue / Sat / Value notes |
|---|---|---|
| Turf, lit stripe | `#4d7a38` | H 100–110°, S 30–40%. Stripe pair ≤ 0.4 stop apart |
| Turf, dark stripe | `#40682f` | Same hue; value difference only, never hue shift |
| Wear / dirt | `#6a5b3a` | **H 40–48°, never below 35°.** Current `uColDirt` `0x6a5237` (H≈28°) is the salmon-streak bug: a red-brown over green complements into pink under a warm key. `src/world/field/TurfMaterial.ts:395` |
| Sky zenith (day) | `#4a86d8` | Keep (`ZENITH_RAMP` is right) |
| Sky horizon (golden) | `#efa06a` | Must be visible as a *gradient* in any frame containing sky — see §6.3 |
| Sky zenith (night) | `#0b1226` | Never pure black; twilight blue holds the bowl silhouette |
| Skin | base `#b08268` ± | H 20–35°, S 20–35%, L* 25–75 across the roster. `PlayerRig.ts` default is correct |
| Home kit | `#1d4e94` | Full saturation permitted |
| Away kit | `#f2f2ee` + `#b3372e` trim | White reads at night; red trim full sat |
| Disc | `#fafafa` | Highest-value object on the pitch in every daylight frame |
| Crowd | S ≤ 45%, V 25–65% | Team-hue biased but muddied; the crowd must never out-saturate the kits |
| Concrete / stands | `#8b8578` | H 30–45°, S ≤ 12% |
| Steel / masts | `#7c828a` | S ≤ 10% |
| LED boards (day) | pastel bg, V ≤ 80 | One accent hue per panel — already close |

## 3. Light

**Day (hours 16.0–19.4).** Key:fill 4:1 on a vertical surface at 16.0–17.5, opening to 5.5:1 at 18.5+ as the sky share collapses. `Ambient.ts` now solves this budget honestly — do not re-add fill; verify with `lightReport()`. The eye is led by the warm key raking the subject against cooler ambient shadow; DOF (already per-shot in `Shots.ts`) does the rest. Turf meters just under middle grey (the `Exposure.ts` contract) and the sky is allowed to roll off hot.

**Night (hour 21.5) — the hard environment, in numbers.**
- Key:fill **6:1** on a vertical surface. `Ambient.ts` already targets this; keep it. Six-to-one is what "floodlit" means — deep but not opaque shadows, four of them per player (the `Towers.ts` four-caster invariant is the signature; protect it at every tier).
- Absolute level is the regression: `perSpot = 6400` cd in `src/render/lighting/Towers.ts:585` delivers ~1.5 irradiance units mid-pitch against a `NIGHT_TARGET` of 3.15 (`Exposure.ts:38`), so the meter runs exposure up until the only bright thing — the LED ribbon — clips. **Raise `perSpot` to 18,000 cd** (≈ +1.5 stops, ~4.1 units mid-pitch). The meter then holds turf at 0.30–0.40 post-grade luma with exposure near 1, and the ribbon falls back into range.
- LED boards at night must render at **0.75–0.85 of display white, never clipping**. `Screens.ts:356` night gains (perimeter 2.40, ribbon 1.95, jumbo 2.65) are tuned for an exposure of 1; make `uGain` divide by the current renderer exposure so boards hold constant *screen* luminance, or hard-drop to 1.3 / 1.0 / 1.5.
- Stands at night sit 1.5–2.5 stops below the pitch. Crowd faces catch rig spill, not their own light.
- Where the eye goes: the brightest square metre in the night frame must be the turf around the disc. Board ≤ 2× local turf luma, always.

## 4. Focal hierarchy, per framing (`src/capture/Shots.ts`)

Global rule: in every gameplay shot the subject is **the disc and the player in possession**; LED boards are never in the top three contrast elements of any frame.

| Shot | Subject | Supports | Must recede |
|---|---|---|---|
| broadcast | thrower + disc at frame centre-third | mow stripes leading upfield, defence shapes | boards, crowd, bench furniture |
| sideline | handler's pivot vs the mark (two bodies) | compressed defenders in bokeh | boards behind (defocused by f/2.4 — keep) |
| closeup | face and jersey of receiver | rim of golden key on hair/shoulder | everything; background is pure bokeh |
| layout | horizontal receiver + disc at fingertips | turf spray, trailing defender | crowd wall |
| disc | the spinning disc | motion trail, warm field bokeh | all |
| stadium | the lit bowl as a lantern in the landscape | sky gradient, floodlight glow, car park life | city blocks, exterior screens |
| turf | grass blades + chalk edge | mow-stripe boundary in near field | stands (defocused — already working) |
| crowd | 8–12 readable individuals | banners, team-hue clumping, depth falloff | LED ribbon must not slice the frame |
| endzone | the catch + celebration pose | low sun flare, crowd rising behind | boards, photographers |
| night | the four-shadow player group mid-pitch | rig glow, cool turf, twilight sky band | ribbon (currently the subject — exactly backwards) |

## 5. Cut list

1. **SUBSTITUTION boxes** — association-football furniture that does not exist in Ultimate. Delete the decal and `subBoxMaterial()` wholesale: `src/world/stadium/Sideline.ts:170–178, 328–359`. Cut, do not restyle.
2. **Chromatic aberration** — `uCa: 0.7` in `src/render/post/Film.ts:33` is the magenta/cyan corner fringing over one-pixel crowd detail. At this resolution the effect cannot read as a lens. Set to 0. Keep vignette and grain.
3. **The "cut" scratch channel mid-field** — `WearMap.ts:106` sprays high-frequency streaks across the centre that read as scratches on the render, not wear. Keep the lane wear, brick-mark blotches and endzone mud; kill the mid-field cut term (and retint dirt per §2).
4. **The star-cross flare in the tower glow** (`makeGlowMaterial` star term, `Towers.ts:683–685`) — reads as a sticker, and at 18,000 cd bloom will do the job honestly.
5. **Blank exterior jumbotron faces** in the establishing shot — the huge mottled grey screen dominating stadium.png mid-frame. If a screen faces the camera it shows content and glows; otherwise it does not exist in this framing.

## 6. Three highest-leverage changes, ranked

**1. Put the athletes in the frame.** The unanimous Round-2 note ("inversion of effort") is half-fixed; this is the other half, and it is cheaper than it looks because the work is *already done*: `src/entities/PlayerRig.ts` is a finished 60-bone procedural athlete with 3 LODs, per-player geometry, and jersey/skin/hair/eyes submeshes — while `src/entities/Players.ts` is a 15-line stub scattering white capsules, and `src/sim/Game.ts` (`buildRoster`, line 246) simulates 14 players whose positions never reach a visible body. Replace the stub: build rigs via `buildRoster()` from `PlayerRig.ts`, drive `rig.root` from the `GameSystem` locomotion states, assign kit materials per §2. Every one of the ten shots contains players; four (`closeup`, `sideline`, `layout`, `endzone`) are *about* them and are currently unscoreable.

**2. Relight the night.** Two coupled edits: `perSpot` 6,400 → 18,000 cd in `src/render/lighting/Towers.ts:585`, and exposure-compensated LED gains in `src/world/stadium/Screens.ts:356` (§3 numbers). Acceptance: in `night`, mid-pitch turf at 0.30–0.40 post-grade luma, four distinct shadows under every player, ribbon ≤ 2× local turf luma with zero clipped pixels, key:fill 6:1 from `lightReport()`. This un-regresses the worst frame and fixes the backwards hierarchy in one pass.

**3. Give the wide shots a sky.** The `stadium` framing at hour 19.4 (sun at ~6° elevation) renders a flat tan card: no sun, no gradient, no clouds, and an exterior lit only by murk. In `src/render/Sky.ts` / `src/render/sky/SkyMaterial.ts`, ensure the horizon-to-zenith gradient (`HORIZON_RAMP`→`ZENITH_RAMP`) and the circumsolar glow actually render at establishing distance, with cloud cover ≥ 20% at golden hour; and confirm the exterior (`src/world/stadium/Exterior.ts`, `world/field/Surrounds.ts`) receives the same warm key and cascade shadows as the bowl so buildings rake warm-on-west instead of reading flat brown. Acceptance: in `stadium`, the sky occupies its band with a visible warm-to-blue gradient, and the lit bowl is the brightest element — a lantern in a dusk landscape, which is the whole point of the shot.

Ship order: 1 → 2 → 3, cuts (§5) alongside any of them — they are five deletions and one hex change, an afternoon that removes most of the remaining noise.
