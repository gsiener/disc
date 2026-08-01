<!-- Written by a Fable 5 agent acting as game design director. Preserved verbatim. -->

Everything verified against source. Here is the brief.

---

# ULTIMATE — Gameplay Design Brief (round 1: make it playable)

Design director's brief, written against the code as it exists on `main`. The simulation is finished and trustworthy; the input layer is finished and mostly unwired; the camera is a viewer, not a director. Nothing below proposes touching `src/sim/DiscPhysics.ts`, `src/sim/Locomotion.ts`, `src/sim/AI.ts`, `src/sim/GameState.ts`, or `src/sim/Rules.ts` beyond reading them.

Reference throughout is FIFA's Tele Broadcast grammar per `/Users/grahamsiener/src/claudeahan/BRIEF.md`. Coordinates are the field frame from `Rules.ts`: origin centre, +Z toward one endzone, X across, sidelines at x = ±18.5, end lines at z = ±50, goal lines at |z| = 32.

---

## 1. The camera

This is the blocker. `src/camera/Director.ts` is an orbit explorer; nothing follows play. Replace its live-mode behaviour with the rig below (keep the explorer behind a debug hotkey, and keep the existing capture-pin behaviour — `shot:applied` still hard-pins).

### 1.1 The Tele rig (the only camera during live play)

One virtual camera on a dolly line parallel to the −X sideline. It translates in Z only, pans, tilts, and zooms. It never cuts while the disc is live.

| Parameter | Value |
|---|---|
| Position X | **−42 m** fixed (23.5 m beyond the −X sideline) |
| Position Y | **15 m** fixed (elevation to mid-field ≈ 20°, to far sideline ≈ 14° — broadcast raking, matches the art direction's golden-hour key) |
| Position Z (dolly) | `camZ = clamp(0.80 × focusZ, −36, +36)`, rate-limited to **12 m/s**, accel ≤ 18 m/s² |
| Vertical FOV | **22° base**, clamped to **[17°, 30°]** (≈ 80–45 mm full-frame; base ≈ 62 mm), zoom rate ≤ **7°/s** |
| Pan rate cap | **38°/s** |
| Tilt rate cap | **18°/s** |
| Look-at damping | critically damped spring, ω = **3.2 rad/s** (τ ≈ 0.31 s) on the aim point; ω = **1.6 rad/s** on FOV |

**Focus point (disc held / dead).** `F = 0.65 × discPos + 0.35 × offCentroid`, where `offCentroid` is the mean XZ of offensive players within 25 m of the disc. Add **lead room**: `F.z += attackDir × 6 m`. Result: the thrower sits at roughly 38% of frame width with 62% of the frame open downfield — the FIFA rule-of-thirds lead.

**Focus point (disc in flight).** Do not track the disc. On `disc:released`, compute `predictPath()` / `predictLanding()` off `DiscRuntime` (they exist and match the real flight exactly) and aim at **the point 60% of the way along the flight by time**, re-predicted at 10 Hz (wind makes early predictions drift slightly). The disc flies *through* the frame toward where the camera is already looking. Assert: the look-at target is always ≥ 55% of the way from disc to predicted landing.

**Huck behaviour (predicted carry ≥ 28 m or flight time ≥ 2.0 s).** Within a 0.25 s ramp: retarget to the 65% path point, add +5° FOV (clamped), raise dolly gain 0.80 → 0.90. The disc may reach |NDC.x| = 0.85 during the first 30% of flight; it must be back inside |NDC.x| ≤ 0.6 by 60% of flight. The camera **leads and waits; it never chases** — a max backhand leaves at 27 m/s (`aero/Throws.ts`) and at 45 m range that is a 35°/s angular rate, which is why the pan cap alone forces the lead behaviour.

**Widen as play spreads.** Solve the FOV that fits the bounding box of {disc, offensive players within 30 m of disc in Z, selected receiver} into **72% of frame width**, clamp to [17°, 30°], rate-limit. Red-zone preset: when the disc is held within 18 m of the attacking goal line, tighten toward 20° and add +6 m of dolly overshoot past `F.z` — the tele leans into the endzone rather than cutting to it.

### 1.2 The cut library

Hard rule first: **zero cuts while `gs.phase` is `LIVE_POSSESSION`, `DISC_IN_FLIGHT`, or `PULL_IN_FLIGHT`** (single scripted exception below). Ultimate has no dead ball after a catch — play is continuous, like football and unlike Madden — so every cut hangs off the rules machine's actual dead phases: `TURNOVER_DEAD`, `CHECK`, `POINT_SCORED`, `TIMEOUT`, `HALFTIME`, `PRE_PULL`.

| Shot | When | Spec |
|---|---|---|
| **Pull aerial** | `PRE_PULL` (2.0 s, per `Game.ts PRE_PULL_WAIT`) through pull flight | pos (−30, 30, pulling goal line ∓ 12), looking down-field; slow push-in 1.5 m/s |
| **Aerial → Tele handoff** | at **60% of predicted pull flight time** — the one permitted mid-flight cut, because the pull is uncontested by rule (`tryCatch` filters to the receiving team during `PULL_IN_FLIGHT`) | hard cut, tele already aimed at the landing point |
| **Low endzone** | on entering `TURNOVER_DEAD` or `CHECK` with the disc inside the red zone (within 20 m of the attacking goal line) | behind the attacked end line: (clamp(discX × 0.5, −8, +8), 2.2 m, attackDir × 56), FOV 28° |
| **Celebration** | `POINT_SCORED` + 0.7 s | low sideline at 12 m from scorer, 1.6 m high, FOV 24°; `postScoreDelay` is 3.5 s — return to aerial for the next `PRE_PULL` |
| **Turnover beat** | on `disc:grounded` / block → `TURNOVER_DEAD` | tele holds framing for 0.8 s (no push — dead air is the drop's feedback), then may cut per red-zone rule |
| **Tighter follow** | not a cut — the tele's red-zone/spread solver already produces it. The moment the phase returns to `LIVE_POSSESSION`, the tele is the camera, full stop. |

Grammar rules, assertable: minimum shot length **2.5 s**; every sideline camera at **x ≤ −6** (never cross the line of play — screen-left must always be the same field direction within a point); endzone camera |x| ≤ 8; disc on screen (|NDC.x| ≤ 0.8, |NDC.y| ≤ 0.85) for ≥ 99% of live frames; thrower and marker both on screen for 100% of `LIVE_POSSESSION` frames; ≥ 5 offensive players on screen while the disc is held.

**Input consequence of any cut (required, ships with the camera).** Movement is camera-relative — `cameraYaw()` in `/Users/grahamsiener/src/claudeahan/src/input/Input.ts` reads the live camera every step. On any cut, latch the yaw fed to `HumanController` at its pre-cut value until the move stick drops below 0.2 magnitude, then adopt the new yaw. Without this, every cut scrambles the player's hands.

---

## 2. Control scheme

The input layer (`ActionMap.ts`, `Human.ts`, `Throw.ts`) is already the right design — analogue charge with the perfect-window quality curve, buffered edges, gates. This section ratifies the existing default map, names it in FIFA terms, and fixes the gaps. Do not redesign; wire.

### Pad layout (Xbox names; `ActionMap` action in parentheses)

| Input | Offence, with disc | Offence, off disc | Defence |
|---|---|---|---|
| **LS** | pivot lean / dish direction | run (camera-relative) | run |
| **RS** | aim the throw; deflection from charge-start facing sets curve; flick ≥ 0.55 = select receiver (`aim`, receiver select) | look/lead | switch hint |
| **A** (`throw` / `switchDefender`) | hold to charge, release to throw | — | tap = switch player |
| **B** (`cancel` / `layout`) | cancel charge; ≥ 0.25 s reads as a pump fake | layout (bid at full stretch) | layout |
| **X** (`bid`) | — | attack the disc (jump/bid) | attack the disc |
| **Y** (`callCut`) | send selected receiver on the cut the stick indicates | demand the disc | — |
| **LB** (`throwModA` / `mark`) | **hold = forehand** | — | hold = active mark |
| **RB** (`throwModB`) | **hold = hammer**; LB+RB = scoober; RB + tilt beyond 0.7 = blade | — | — |
| **LT** (`brake`) | — | analogue brake / hard plant | jockey / brake |
| **RT** (`sprint`) | — | analogue sprint | sprint |
| **D-pad ◄►** (`curveLeft/Right`) | deliberate IO/OI nudge (adds ±0.55 tilt) | — | — |
| **D-pad ▲▼** (`receiverPrev/Next`) | cycle receiver | — | — |
| **Back** (`forceFlip`) | — | — | flip the force side |
| **RS click** (`pivot`) | pivot / fake follow-through | — | — |

This is FIFA-literate by construction: RT sprint, LT shield/jockey, A = the pass with a power meter, B = the panic button, modifiers on bumpers. The offence/defence sharing of A, B, LB is already gated correctly by `intentGates()` in `Game.ts`; one addition — **flush the input buffer on any possession flip** (a buffered `throw` press must never resolve as a `switchDefender` 100 ms later; add a `buffer.clearAll()` on gate transition in `Human.ts`).

### Throw type without modality

Already solved by `resolveThrowType()` and keep it exactly: type is a **chord held at release**, never a toggle. No menu, no mode. Backhand is the unmodified throw; forehand is LB held; hammer is RB; scoober is the two-bumper chord; blade falls out of the tilt axis (RB + |tilt| > `BLADE_TILT` 0.7). Difficulty scaling per type is already priced (`THROW_DIFFICULTY` 1.00 → 1.60) — the HUD meter must show the narrowed perfect window per type (fields `targetHold` / `targetHalfWidth` already exist on `ChargeIntent`).

### Curve

Curve is *positional, like a real throw*: drag the aim stick across your body during the charge. Deflection from the yaw you faced at charge start maps to disc bank — 60° of deflection = full tilt (`tiltSpan`), +1 tilt = right edge down = curves right, handedness-correct because the physics does it (`bank` in `throwDisc`). D-pad nudges add ±0.55 for a deliberate IO/OI without re-pointing. Full tilt costs 14% quality (`TILT_PENALTY`), whipping the stick costs up to 35% (`WHIP_PENALTY`) — the feel is already tuned; expose it, don't retune it.

### Receiver-selection model

**Free aim is authoritative; selection is soft.** The disc goes where the physics says — the sim is the truth and the whole game is built on that. FIFA's semi-assisted through ball is the model:

- Flick RS ≥ 0.55 magnitude while charging → directional select commits (`selectFresh`, already produced in `Human.ts`). The game resolves it to the best teammate in a **35° half-angle cone**, scored 60% angular fit / 25% lane openness (reuse `laneOf`/`laneBlockage` machinery in `AI.ts`) / 15% distance sanity. **This event (`input:receiver`) is currently emitted and consumed by nothing** — see §6.
- Hold the direction ≥ 0.18 s (`cutHoldTime`) → `callCut`: the selected receiver's AI runs the cut the stick indicates (`buildCut` in `Playbook.ts` already constructs all seven route kinds). No AI hook exists yet; add one command channel into `TeamAI`.
- **Aim assist at release**: if a receiver is selected and the raw aim yaw is within 12° of the ideal lead solution, rotate the release yaw toward the lead by up to **5°, scaled by release quality** (perfect release = full assist). Timing skill buys accuracy; the existing quality-noise model (`spread = (1−q) × 0.16` rad in `humanThrow`) stays as-is on top.
- **Dump default**: at stall ≥ 7 with nothing selected, auto-select the reset handler (nearest handler behind the disc). The panic button should already be aimed.
- D-pad cycle and keyboard 1–7 direct-select already exist; keep both.

---

## 3. Player switching

Continuous and central. The policy layer already exists and is good — `pickSwitchTarget` in `/Users/grahamsiener/src/claudeahan/src/input/Switch.ts` scores by time-to-threat (9 m/s weight), raw distance, a 14 m penalty for stealing the marker, an 11 m stick-hint weight, stamina. Ship it; do not fall back to nearest-player.

**Manual model.**
- Tap A on defence → policy switch (threat = `threatPoint()`, which already uses `predictPath` when the disc flies).
- A + RS direction ≥ 0.35 → hinted switch (already wired through `resolveSwitch` in `Input.ts`).
- Double-tap A within 0.3 s → cycle outward through defenders by distance-to-threat (new; the escape hatch when the policy disagrees with you).
- Never hand control to a body that can't act: candidates already carry `eligible` from `Locomotion.isAvailable` (mid-layout, prone, recovering are excluded). Keep that invariant absolute.

**Automatic model (offence).** You are the disc, FIFA-style: `autoSelectControlled()` already snaps control to the thrower. Add the missing half — **control transfers to the intended receiver at release + 0.1 s** when one is selected, and to the catcher at the catch otherwise. That gives the human the catch, the layout bid, and the first pivot, which is where the game lives.

**The turnover, mid-flight.** The hard case, specified:

1. The rules machine flips possession on the block/drop/OOB event — same fixed step, gates flip (`hasDisc` false, `onDefence` true), input buffer flushed.
2. **Control does not move for a 0.6 s grace window.** Yanking the camera *and* the avatar in the same instant is disorienting; the player keeps their body and watches the situation invert around them.
3. During the grace window the indicator announces the flip instantly: one ring pulse (1.4× radius, 0.3 s) and the ring switches to its defence treatment (below).
4. At grace end, policy switch fires with `threatX/Z` = the dead-disc spot (or predicted landing if still moving), *unless* the player has touched move or switch during the window — human intent always wins.
5. If the controlled player is already the best candidate, nothing moves. Assert: no control change while `Locomotion.isAvailable(controlled) === false`.

**The indicator.** Build on the existing `GameplayLayer` ring (`src/ui/Gameplay.ts` — stroke-only, ground-projected, already correct per its own header): 0.85 m radius ring under the controlled player, near-white `rgba(232,242,255,.92)`, facing chevron (exists). On defence, the ring gains a dashed outer ring at 1.05 m rather than a hue change — the art direction reserves saturation for kits and disc, and the HUD respects it. Receiver bracket (exists) marks the selected receiver; switch preview: holding A ≥ 0.25 s ghosts a 40%-opacity ring under the would-be target before commit.

---

## 4. Off-ball legibility

FIFA reads as shape because 22 players hold a formation the camera can see. Our equivalent is already deliberately engineered in the sim — `Game.ts` pins both AIs to **vertical stack + person force defence** with zone bias pushed negative, with a comment explaining exactly why (a zone renders as "fourteen bodies with no relationship"). The design answer is a layered one: **AI holds the shape, the camera guarantees the shape is on screen, the HUD annotates only what geometry cannot say.**

**AI (keep, enforce).** Vertical stack at 4.7 m spacing (the tableau's number; make live play hold ≥ 4 m), lane arbitration so two cuts never share a lane (`LaneKey` set in `Playbook.ts`, already built), dump handler stationed behind the disc. These are the lines-and-width of our sport.

**Camera (guarantees, from §1).** With the disc held: thrower + marker always framed, ≥ 5 offensive players framed, lead room open downfield so the stack and the space behind it are both visible. The stack must read as a *column* from the tele angle — that is what the 20° elevation buys.

**HUD (annotate the invisible only — all in `src/ui/Gameplay.ts`, stroke-only, desaturated).**
- **The force**: a 130°, 1.1 m-radius ground arc on the thrower's break side — the one piece of structure a newcomer cannot infer from bodies. Flips visibly when a human flips the force (`input:force` already fires).
- **The landing ring** (exists): where the disc will come down, on every live flight. The single most important defensive read; it is also what makes the switch policy's choices feel *explicable*.
- **Cut-route ghost**: while `callCut` is held, the commanded route from `buildCut` as a dashed line fading over 1.5 s. You see the order given, then judge the execution.
- **Dump urgency**: stall ≥ 7 → gauge (exists in `Scorebug.ts`) shifts amber and the reset handler auto-brackets.
- **Recovery dimming**: ring at 40% opacity while your body is unavailable — the 2.04 s layout cost must be legible, not mysterious.

**What the player can therefore see and decide.** As thrower: where the force is (arc), which lane the defence concedes (bodies + the ghost of a called cut), when to bail (stall gauge + auto-bracketed dump). As defender: where the disc will land (ring), who has the best claim on it (switch preview), which shoulder to take away (force arc + mark hold). Nothing else earns pixels.

---

## 5. Game feel

The identity constraint first: Ultimate is **non-contact and self-officiated**. There is no whistle, no referee, no crunch. Weight comes from the locomotion model (a 90° cut genuinely costs 33% of speed — trust it and animate it) and from the disc; punctuation comes from possession changes only.

**Release.** The charge meter is the heartbeat: fills over 0.85 s, perfect window ±0.09 s, narrowing per throw type — draw it from `targetHold`/`targetHalfWidth` live. A perfect-window release (`charge.perfect`, centre 35% of the window): meter flashes white 90 ms, ring pulse on the thrower, layered snap SFX (fingers + gyro hiss rising with spin rate), 40 ms rumble at 0.3. Overcharged: audible flutter and the visible nose-up wobble the physics already produces (`nose = (1−q) × 0.08`). **No timescale change on an ordinary throw** — FIFA doesn't stop time for a pass and neither do we.

**Catch.** Routine: 70 ms rumble at 0.5, hand-slap SFX, nothing else — completions are the metronome, not the drama. Contested or layout catch: **0.45× timescale for 0.35 s starting at the catch frame** (never before resolution — pre-slowing telegraphs the dice roll), turf spray off `player:land {layout:true}`, crowd surge.

**Block.** The peak moment of the sport on defence: **0.35× for 0.45 s**, crowd roar, 120 ms rumble at 0.7, disc scuff (`markScuff` exists). This is the one event allowed the full hitstop treatment.

**Drop.** The opposite treatment: no slow-mo, no shake. Crowd gasp, then 0.8 s of near-silence while the camera holds its framing dead still on the disc in the grass. Dead air is the feedback.

**Layout.** Rumble ramps at 0.2 through the flight, 0.5 thump on landing; then the 2.04 s of recovery plays out undecorated — the cost *is* the feel.

**The self-officiated texture.** The marker counts the stall *aloud* — "stalling one" through "ten", audible from the mark, crowd joining late (the audio system already reacts at count ≥ 7 via `stall:tick`). Contact events (`player:contact` with `foulOn`/`called`) resolve through player voices and a hand signal into the `CHECK` phase (0.65 s), with a lower-third line (`LowerThird.ts` exists) — never a whistle SFX anywhere in the mix. Score: crowd and team shout, no horn; this is a club final with its first TV truck, not an arena.

**Camera feel.** Zero procedural shake on the tele — broadcast tripods do not shake. The only permitted flinch is a 0.2° tilt dip settling over 0.5 s on a layout catch (the operator's flinch). Slow-mo is implemented as a render-side scale on the fixed-step accumulator (sim untouched, determinism preserved, disabled under `ctx.capture`).

---

## 6. Build order — the three highest-leverage items

**1. The gameplay camera — `/Users/grahamsiener/src/claudeahan/src/camera/Director.ts`** (plus the yaw latch in `/Users/grahamsiener/src/claudeahan/src/input/Input.ts`, whose `cameraYaw()` re-reads the live camera every step). Everything in §1. This is the reason the game has never been played: the sim runs full matches headless, the input layer produces intents, and nothing puts the play on screen. Reads `ctx.sys.game` (`gs.phase`, `attackDir`, roster positions) and `ctx.sys.disc` / `discRuntime.predictPath` — all already public. Every framing rule in §1 is written to be asserted in a headless test against the deterministic sim.

**2. Receiver targeting and control handoff — `/Users/grahamsiener/src/claudeahan/src/sim/Game.ts`.** The seam is already cut and left empty: `Human.ts` produces directional select and `callCut`, `Input.ts` emits `input:receiver` — and I verified nothing in the repo consumes it; `humanAction()` reads only `receiver.cycle`, and `AI.ts` has no callCut entry point. Implement cone-scored selection (§2), the callCut command into `TeamAI`, the 5°-max quality-scaled aim assist in `humanThrow`, and control transfer at release plus the 0.6 s turnover grace in `autoSelectControlled()` (currently: thrower on offence, nearest-to-threat after 1.5 s idle on defence). With #1 and #2 done, the game is *playable* end to end on the existing 828 assertions' worth of sim.

**3. The off-ball legibility layer — `/Users/grahamsiener/src/claudeahan/src/ui/Gameplay.ts`.** Force arc, cut-route ghost, dump auto-bracket at stall 7, defence ring treatment, recovery dimming (§3–4). The projector, ring, bracket, and landing-ring infrastructure already exist in that file; this is days, not weeks, and it is what turns fourteen moving bodies into a sport a viewer can read.

The feel pass (§5) is item 4 — it rides on events that already exist (`disc:released`, `disc:caught`, `player:land`, `stall:tick`, `player:contact`) and should land incrementally behind the first three.

One deliberate rejection, for the record: no cut-to-endzone-camera during live red-zone possession, even though an early draft of the parent brief implies it. Ultimate has no dead ball between catches; a live cut both violates the no-cut-mid-play rule and scrambles camera-relative control. The tele's red-zone preset (tighten + dolly overshoot) delivers the low-angle drama at the moments the rules machine actually goes dead. If playtests want more, revisit with the input latch proven first.
