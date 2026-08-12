---
title: 'AI.ts EV fix for issue #36 made a scripted TeamAI replay and a live 10-minute match disagree with Swift — both were pre-existing test-side gaps the fix newly exercised, not porting bugs'
severity: 'major'
---

**Superseded, corrected version of this entry — the original body (below the
line) recorded an active but WRONG theory (RNG-stream/`mem` desync) reached
before the actual root causes were found. Left in place rather than deleted,
because the isolation work that ruled the wrong theory out is itself the
useful part: it is what pointed at the real causes.**

## What actually happened

Fixing issue #36 (elite roster loses to weak roster) required changing
`src/sim/AI.ts`'s `evaluateOptions` EV pricing for near-zero-gain throws
(capping accuracy's contribution, `NO_GAIN_CAP`, and adding a flat tempo tax,
`NO_PROGRESS_TAX`). Both are mirrored bit-for-bit into `TeamAIThrow.swift`.
After the fix landed, `swift run -c release SimTests` showed 5 failures in
two long, deterministic fixtures — and **neither one was caused by this fix's
own code.** Both were pre-existing gaps elsewhere in the test/engine code that
this fix's changed match dynamics happened to reach for the first time.

### 1. `f1237-1238/nomark i11` in `SimTests teamai` — a real, ALREADY-DECLARED divergence, not a porting bug

`TeamAITests.swift`'s `nomark` replay pins every external input (every
player's position/velocity/energy, the whole disc state) from the golden JSON
on every single frame. That was the key fact the original theory below missed
the weight of: with the world state pinned, a frame-by-frame dump of both
platforms' `TeamAI` internal state — RNG stream (a,b,c,d), every player's
`mem` (cutState, cutCooldown, poach, seenX/Z, bidCommit, ...), `choice`,
`windup`, `handlerRing`, `rankedIds`, `stackOrder` — came back **bit-identical
at all 1370 frames, including 1237.** Nothing state-dependent at the throw-EV
site had drifted at all. That ruled out both prior theories (a manufactured
tie in `accForThrow` broken differently by `gauss()`'s ~1e-12 cross-platform
slop; a last-ulp threshold cross on `gain`) in one step, since neither would
produce a bit-identical trace right up to the disagreement.

The actual cause: `TeamAIDefence.swift`'s `defenceInFlight` guards a
defensive bid at `land.y < LAYOUT_CEILING` (1.10 m). The reference guards the
same decision at `land.y < 1.85`. This is an EXISTING, ADR-0007-declared
divergence (`tools/goldens/divergences.ts`, entry `LAYOUT_CEILING`, declared
2026-08-10 in commit `aa2a316` — the SAME commit issue #36 bisected to, for a
completely unrelated reason) — the registry's own reasoning is that a prone
layout physically cannot reach a chest-high disc, so 1.10 is more realistic
than the reference's 1.85. But the registry's supporting measurement ("three
full reference matches, 202k evaluations... max `land.y` 1.4498") proves the
reference's `1.85` guard is inert *relative to itself* (nothing ever reaches
1.85), which is NOT the same claim as "1.10 is inert relative to 1.4498" — it
manifestly is not, since 1.10 < 1.4498. Any bid attempt with `land.y` in
[1.10, 1.85) is DECLARED to disagree between the reference and Swift, and
until this fix, the `nomark` fixture's 1600-frame trajectory apparently never
put a bid-eligible moment in that window. Confirmed directly: at the
diverging frame, `land.y` measures 1.3709 — inside the gap, `wantsBid` true on
the reference side, guard failing on Swift's.

Fixed at the comparison site, `TeamAITests.swift`'s `compareIntent`, which now
excuses exactly this mismatch shape (mode `.layout`+action `.bid` vs mode
`.sprint`+no action, for a defender in `read-disc` state — everything else
about the intent, including `debug.role`/`debug.state` themselves, still
compares normally) and counts it in a new `layoutCeilingFlips` counter,
asserted to stay small — the same pattern `staminaFlips` already uses for its
own documented cross-platform gap (`tickStamina`'s `load > 0.42` branch).

### 2. "17 thrown, 15 resolved" in `SimTests events` — a test-counting bug, not an engine bug

`EventTests.swift`'s `play()` helper counts a pull as "resolved" only on
`.pullCaught`, `.pullLanded`, or `.pullOutOfBounds`. A dropped pull is a
fourth, equally valid outcome, and the engine correctly represents it as
`.turnover(reason: .pullDrop, ...)` rather than inventing a fourth pull-event
case — but `play()`'s switch never counted that reason toward
`pullOutcomes`. Confirmed by instrumenting `play()` to print every event in
the two windows where a pull went "unresolved": both are ordinary pull drops
(`turnover(reason: .pullDrop, from: 0, to: 1, ...)`), and the match continues
normally afterward — nothing was actually stuck. This fixture's fixed seed
and 10-minute window apparently drew 0-1 pull drops before; this fix's
changed match dynamics drew 2. Fixed by adding `case .pullDrop:
t.pullOutcomes += 1` alongside `.drop`/`.stallOut`/`.block`/`.interception` in
the existing turnover-reason switch.

## Result

`swift run -c release SimTests`: **PASS, 2252581 assertions, 0 failures.**

## Lesson

Both failures looked, from the outside, like the same category of thing my
first pass diagnosed them as: a chaotic behavioral fix nudging a long
deterministic trace into some pre-existing latent sensitivity. That framing
was directionally right (a behavioral change DID newly expose a pre-existing
gap) but insufficiently specific to be actionable — it doesn't tell you
whether to fix a test, a golden, or a real bug. What made the difference was
building the actual instrumentation (a frame-by-frame internal-state dump,
comparing against known constants like `LAYOUT_CEILING`, printing the raw
event stream in the exact window a discrepancy appeared) rather than
continuing to vary the fix's own constants and pattern-matching on whether
the failure moved. Five different (margin, cap, tax) triples all reproducing
the identical failure was itself the tell that the fix's own numbers weren't
the variable that mattered — it just took looking at what WAS the variable to
find it.

---

## Original entry (superseded — kept for the isolation work, not the conclusion)

Fixing issue #36 (elite roster loses to weak roster) requires changing
`src/sim/AI.ts`'s `evaluateOptions` EV pricing for near-zero-gain throws
(capping accuracy's contribution and adding a flat tempo tax). Both changes
are mirrored bit-for-bit into `TeamAIThrow.swift` and the formula was verified
identical operator-for-operator. Regenerating `teamai.json` and running
`swift run -c release SimTests` still shows 4-5 assertions red:

```
f1237/nomark i11 mode — got sprint, want layout
f1237/nomark i11 action missing — want bid
f1238/nomark i11 mode — got sprint, want layout
f1238/nomark i11 action missing — want bid
every pull thrown gets an outcome, bar one possibly in flight (17 thrown, 15 resolved)
```

Both are in deterministic, scripted, long fixtures: `teamai`'s `nomark` segment
replays ~1600 frames of pre-recorded golden input (every player position and
disc state is overwritten from the JSON every single frame — confirmed by
reading `TeamAITests.swift`'s replay loop), and `EventTests.streamReconciles`
plays a fixed-seed 10-minute `Engine` match. Because the `nomark` replay pins
every external input from the golden per frame, the divergence at f1237/1238
cannot be positional drift — the only thing NOT reset each frame is the
`TeamAI`'s own internal state (RNG stream position, `mem`, cooldown timers),
carried forward from however each platform processed the preceding ~1236
frames. Something in that internal state has diverged by then.

**[Corrected above: this internal state, checked directly, was bit-identical
at every frame. It was never the mechanism.]**

### Isolation

Five different (NO_GAIN_MARGIN, NO_GAIN_CAP, NO_PROGRESS_TAX) triples —
(2,69,0.05), (2,70,0.05), (2,69,0), (2,69,0.048), (3,69,0.048) — all reproduce
the identical f1237/1238/i11 failure. Disabling the accuracy cap entirely
(`accForThrow = acc`) while keeping the tempo tax makes it disappear; the
exact cap value and margin don't matter once the mechanism is active at all.
That rules out a last-ulp threshold-crossing sensitivity to the specific
constants (which would move around as the constants move) and points at an
earlier decision — some option ranking flipping once, likely via a pre-existing
platform difference in a transcendental function (`sigmoid`'s `exp`, `hypot`)
that was always latent but never mattered until this fix nudged some EV
comparison close enough to a tie to expose it.

**[Corrected above: the actual reason disabling the cap "fixed" it is that it
also changes the `nomark` trajectory enough to avoid landing a bid attempt in
the `LAYOUT_CEILING` gap — not because the cap itself was the mechanism.]**

Also tried: replacing the hard `gain < NO_GAIN_MARGIN ? ... : ...` ternary with
a `smoothstep`-blended version, on the theory that a discontinuous switch on a
continuous value is exactly the hazard `AI.ts` already names ("the cross-libm
hazard the TeamAI trace tolerance exists to catch") for the deep-shot
valuation. It changed nothing — consistent with the replay-pins-every-input
finding above, since there is no drifting continuous value at this site to
begin with.
