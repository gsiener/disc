# Bug corpus — real historical defects in this project

Built for issue #58 (retiring the TypeScript oracle). Every entry is a defect this
repository actually suffered, with a citable source, and a concrete mutation that
re-introduces it into the **current Swift source** so a candidate check can be graded
against it.

Sources mined:

- `.agents/friction-log/` — 97 entries. `INDEX.md` covers only 80 of them and is stale in
  both directions (see "Source notes" at the bottom).
- `tools/goldens/matchdiff.ts` header — names four integration bugs explicitly. **All four
  are captured** (B-19, B-04, B-05, B-13).
- `swift/Sources/SimChecks/Goldens/divergences.json` — the ADR-0007 registry. **It contains
  exactly one declared divergence** (`LAYOUT_CEILING`), plus a scraped constant table. It is
  not a bug list; it yielded one entry (B-14a) and corroborating evidence for B-11/B-35.
- `git log` — 316 commits (not ~330).

---

## Summary

### Bugs per subsystem

| subsystem | count | ids |
|---|---|---|
| Throw solver / aero | 10 | B-01 … B-10 |
| Catch resolution & the catch band | 9 | B-11 … B-18 (incl. B-14a) |
| AI decision layer (TeamAI, Playbook, pitch scaling) | 12 | B-23 … B-34 |
| Rules & calls layer | 4 | B-19 … B-22 |
| Locomotion | 6 | B-35 … B-40 |
| Engine wiring / disc runtime / construction | 6 | B-41 … B-46 |
| Goldens & divergence tooling | 4 | B-47 … B-50 |
| App/frame layer (outside the sim, included for completeness) | 2 | B-51, B-52 |
| **Total distinct production bugs** | **53** | |

A further **9 test-and-harness defects** are catalogued separately at the end. They are real
and cost real time, but they cannot be re-introduced into production Swift source, so they
are not mutation targets.

### Bugs per "how it was caught"

| how caught | code | count | ids |
|---|---|---|---|
| Match-level differential (`matchdiff`) — the ONLY thing that saw it | **MD** | 2 | B-19, B-41 |
| A component golden / differential fixture | G | 7 | B-09, B-10, B-12, B-34, B-35, B-36, B-42 |
| Mutation testing during a port (author testing their own port) | MT | 2 | B-05, B-33 (B-35/B-36 also dual-coded G) |
| A property / invariant assertion in SimChecks or `tools/test-*.ts` | P | 7 | B-20, B-30, B-31, B-37, B-39, B-40, B-49 |
| A telemetry band going red (rate/percentage assertion) | TB | 6 | B-22, B-27, B-28, B-29, B-32, B-43 |
| A human noticing on screen / playing the game | H | 4 | B-11, B-23, B-51, B-52 |
| Targeted instrumentation while investigating something *else* — no check fired | I | 13 | B-01, B-02, B-03, B-04, B-06, B-07, B-08, B-15, B-16, B-17, B-21, B-26, B-46 |
| **Nothing. Found by audit, code review, or reading — latent for days or forever** | **N** | 12 | B-13, B-14, B-14a, B-18, B-24, B-25, B-38, B-44, B-45, B-47, B-48, B-50 |

**25 of 53 were caught by nothing that runs automatically** (categories I + N). That is the
honest headline: this codebase's checks have historically been better at *pinning* behaviour
than at *finding* defects.

### THE BAR: bugs caught only by goldens or matchdiff

These are the entries where, on the historical evidence, deleting the TypeScript oracle
deletes the only thing that noticed. A replacement Swift-native spec must clear these or
knowingly accept the loss.

**Caught only by `matchdiff` (the match-level differential against the TS reference):**

- **B-19 — the severed `LocoHost`** (issue #55). Strips and receiving fouls were
  *unreachable* in the Swift port for the entire life of the feature. `catchContactCall` was
  differed bit-exact and green. 2.24M component assertions were green. The only signal was
  matchdiff's **reachability parity**: 3 strips over 11 reference matches, 0 over the same 11
  in the port. This is the single most important entry in this document.
- **B-41 — `autoPull` was not a port of `doPull`**, aiming 16.8 m short. Surfaced through
  matchdiff's `turnover:pull-drop` rate band — and *barely*: the 8-11x gap sat under the
  absolute floor with 0.08 events/match of headroom, so matchdiff was green on it for
  several commits (`.agents/friction-log/20260811-matchdiff-pull-drop`). Property tests in
  `EngineSeamTests` looked at the pull and could not see it, by construction.

**Caught only by a component golden / differential fixture (would be lost with the oracle
unless the fixture is re-anchored):**

- B-34 (`AIWorld` struct write discarded — 44 `teamai` differential assertions)
- B-35 (roster attribute draw order — 297 assertions)
- B-36 (`FootState` value-copy hazard — locomotion trace, 87,643 assertions)
- B-12 (`predictCatchPoint`'s disc-peer branch below the catch floor — `catchband` golden)
- B-09, B-10 (throw-solver sweep findings)
- B-42 (`stagePoint` formation — found while building `lineup.json`/`pull.json`)

And one caught only by a **property** assertion that exists because a golden *cannot* express
it: B-31 (minis geometry in `PlaybookTests` — "no golden can check that, since `Playbook.ts`
cannot express a second pitch").

**Near-misses worth naming:** B-05 (`throwReleaseSpeed` was never ported at all — a
Swift-only mutation of it survived 2,240,000 green assertions) and B-13 (the reference's
catch predictor reached the disc through the *render* system, so the two engines were
reasoning about different discs and every golden set `sys: undefined` on purpose). Neither
was caught by anything; both are named in the matchdiff header as motivating cases.

---

## Throw solver / aero

### B-01 — the aim plane sat above the release height, so every flat throw was solved into the turf
- **source**: `a77148b` ("The disc was being thrown at the receiver's feet"); reopened and
  properly closed at `ee29260` / `e0ce282`; `.agents/friction-log/20260811-the-aim-height-was-repaired`
- **subsystem**: throw solver
- **symptom**: the median completion was aimed 9.9 m and caught at 6.8 m — the intended
  receiver turned round and ran *back* to meet a disc twelve metres short of where it was
  thrown. Grounded throwaways were 2.8% of every pass.
- **root cause**: `probeThrow` reports the distance at which a flight *descends* through the
  catch plane, and falls through to ground contact when that crossing never happens. The AI
  asked for `aimY = 1.35` (a chest); `releaseOrigin` puts a standing player's hand at
  ~1.05 m. A throw that never rises above 1.35 m cannot descend through it, so the crossing
  test could not fire on any flat throw in the game.
- **how it was caught**: **I** — nothing. Found by instrumenting aimed-vs-caught distance
  while chasing a different problem. `tools/goldens/throwsolver.ts` swept `from.y = 1.35`,
  24 cm above the tallest player in the game, so 640 solver cases could not reach a defect
  present in **1699 of 1699** live throws.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift`, `solveThrow` — remove the
  cap that clamps the asked-for catch plane to `from.y - CATCH_PLANE_DROP`, restoring a bare
  `aimY = AIM_HEIGHT` (1.35, `AI/AIMath.swift:120`).

### B-02 — the elevation search assumed range was monotonic and always took the lofted root
- **source**: `bfc6385` ("The solver shapes the throw, and the catch stops being a lottery")
- **subsystem**: throw solver
- **symptom**: throws hung in the air six times longer with six times the lateral curve —
  long enough for a defender to arrive. Deep game effectively dead.
- **root cause**: a 20.5 m/s backhand's range peaks near −0.02 rad and falls away either
  side, so almost every reachable distance has a flat root and a lofted one. Plain bisection
  walks past the peak and takes the lofted root every time.
- **how it was caught**: **I** — found by direct sweep of the extracted solver while working
  on #17/#40; no fixture existed for `solveRelease` before this commit created one.
- **mutation**: in `swift/Sources/UltimateSim/Aero/ThrowSolver.swift`, replace the
  peak-scanning elevation search with a plain monotonic bisection over the elevation
  bracket (i.e. delete the "scan up to the peak, bracket the FLAT root" step).

### B-03 — the solver had no bank axis, so it paid for curve with heading
- **source**: `bfc6385`
- **subsystem**: throw solver
- **symptom**: on a huck, the disc was aimed roughly fifteen degrees away from the man
  catching it, and about a third of hucks left the field.
- **root cause**: a disc turns over; with no solved bank the only correction available was
  to rotate the aim off the receiver and hope the flight came back. A signed per-throw-type
  constant cannot substitute: the same backhand drifts +3.2 m at 22 m/s and −12.2 m at
  26 m/s.
- **how it was caught**: **I** — measurement during the #40 calibration, not a check.
- **mutation**: in `ThrowSolver.swift`, force the solved `bank` to 0 and re-enable a
  heading-only lateral correction.

### B-04 — a short ask was answered as a too-long one: 42.1% of asks under 6 m overshot
- **source**: `6ff676c` ("The AI can throw a dump, and the solver stops answering the wrong
  question"); named in `tools/goldens/matchdiff.ts:13`
- **subsystem**: throw solver
- **symptom**: "a one metre reset was released as a nineteen metre bomb." 11.9% of all AI
  throws overshot their aim by >3 m; 42.1% of asks under 6 m did; worst was a 0.8 m reset to
  a named receiver that flew 20.6 m. The AI had no dump.
- **root cause**: the elevation scan brackets a root only on a *rising* crossing
  (`r.dist >= want && prevD < want`). When the flattest legal launch already carries further
  than the ask, that never fires, no cell is recorded, and control falls through to the
  "out of range: throw it as far as it goes" branch, which sets the **maximum**-distance
  angle. A second face: `aiThrow` clamped `powerForSpeed` at 0.12, and 12% power on a
  backhand carries 19 m at its best angle — the human path had solved this in
  `humanReleaseParams` and the AI path never got the fix.
- **how it was caught**: **I** — nothing. Its own goldens were green throughout
  (`matchdiff.ts` header: "the throw solver bombed 42% of short throws in one engine and not
  the other, while its own goldens passed"). Found by live instrumentation of overshoot.
- **mutation**: in `ThrowSolver.swift`, delete the trough-tracking / falling-crossing arm of
  the elevation scan so only a rising crossing brackets a root; and re-floor the AI release
  speed at a fixed `powerForSpeed` clamp instead of solving release speed downward.

### B-05 — `throwReleaseSpeed` was never ported, and a Swift-only mutation of it survived 2.24M green assertions
- **source**: `6ff676c`; named in `tools/goldens/matchdiff.ts:15-16` and
  `swift/Sources/SimChecks/MatchDiffTests.swift:15`
- **subsystem**: AI / throw solver seam
- **symptom**: none observable — that is the point. The function decides how hard every AI
  throw leaves the hand and was in **no fixture at all**.
- **root cause**: new in `bfc6385`, added to the reference and to Swift without a golden.
- **how it was caught**: **MT / N** — caught by deliberately mutating it and finding that
  2,240,000 assertions stayed green. That is a coverage finding, not a detection.
- **mutation**: in `swift/Sources/UltimateSim/AI/AIMath.swift:315`, scale
  `throwReleaseSpeed`'s stretch term by 1.15 (a Swift-only change, no reference counterpart).
  A spec that cannot see this is exactly as blind as the suite was.

### B-06 — `throwFlightTime` was two functions wearing one curve
- **source**: `bfc6385`; the split survives at `AI/AIMath.swift:315` / `:338`
- **subsystem**: AI throw decision
- **symptom**: the lead ran short by 25% at 23 m and 50% at 42 m — always in the direction
  that puts the disc behind a still-running receiver, and always telling the thrower that a
  covered man was open.
- **root cause**: one curve, fitted for "how hard to throw", was also used for "how far to
  lead". Fitted for the first and merely used for the second.
- **how it was caught**: **I** — measurement during the #17/#40 calibration.
- **mutation**: in `AI/AIMath.swift`, make `throwFlightTime` return
  `throwReleaseSpeed`-derived time (i.e. re-merge the two functions onto the release-speed
  fit), and revert the lead fractions `LEAD_RUN` 0.42 / `LEAD_CUT` 0.60 to their pre-split
  values.

### B-07 — `probeThrow` ignored `req.speed` while `release` honoured it
- **source**: `6ff676c` ("`probeThrow` had to start forwarding `req.speed` for that to mean
  anything"); the Swift port's own comment had said it "looks like an oversight and it may
  be one"
- **subsystem**: disc runtime / throw solver seam
- **symptom**: a speed-overridden request was *predicted* at one speed and *flown* at
  another, so every solve against an overridden speed was answering a different question.
- **root cause**: two entry points into the same flight model, one of which dropped a field.
- **how it was caught**: **I / N** — the Swift port's comment had flagged it as a suspected
  oversight and nothing acted on it until the dump work forced the issue.
- **mutation**: in `swift/Sources/UltimateSim/Play/DiscRuntime.swift`, have `probeThrow`
  ignore the request's `speed` and use the throw-type default.

### B-08 — the throw solver is wind-blind when aiming
- **source**: `.agents/friction-log/20260810-throwsolver-wind-blind` (major); fixed at
  `88673a0` (reference) and `ce96e93` (Swift port)
- **subsystem**: throw solver
- **symptom**: at 8 m/s of wind, 16.9% throwaways and 78.8% completion — "one throw in five
  missing entirely." A pre-trim lateral residual reached **37 m on a 32 m throw** under a
  9.5 m/s crosswind. A 1.5 m/s crosswind was enough to put a minis pull out the side.
- **root cause**: `DiscPhysics.simulate` integrates a wind vector properly; the solver that
  decides *what release to aim* never saw it. Every throw was aimed as if the air were
  still.
- **how it was caught**: **I** — a direct probe (`tools/_wind_probe.ts`, archived in that
  entry's `artifacts/`). It went unnoticed while match wind was ±1.5 m/s and only became
  dominant when the zone-defence work (issue #20) required wind above 4.5 m/s. Note the trap
  recorded in `.agents/friction-log/20260811175247-tools-test-ai`: the acceptance test the
  issue cited (`tools/test-ai.ts`'s "windy completion %") **could not see this fix at all**
  and was measuring a different bug (see B-27).
- **mutation**: in `ThrowSolver.swift`, delete the heading secant that runs after bank has
  settled (the one gated on the 2 m/s crosswind deadband and reading its error in the fixed
  target frame).

### B-09 — the lateral-drift heading correction made the miss *worse*
- **source**: `33bae36` ("The throw solver had no check, and now it has one that found
  things")
- **subsystem**: throw solver
- **symptom**: total miss 0.79 → 2.32 m at 35% of range; 4.81 → 7.27 m at 50%.
- **root cause**: once the disc cannot reach `want`, rotating by an angle computed for the
  full distance swings a *short* landing point sideways. Below a third of range the
  correction never trips its own 0.25 m gate at all.
- **how it was caught**: **G** — by the throw-solver sweep fixture created in that same
  commit, flying `solveRelease` against nobody. Inside a match the signal is invisible:
  "did the disc arrive" reads ~2.6 m whether the solver works or is deliberately broken,
  because the receiver runs onto the lead.
- **mutation**: in `ThrowSolver.swift`, widen the lateral-drift gate (`0.25 m` → `0.0`) so
  the correction applies at every range.

### B-10 — `maxThrowRange` and the flight model disagree above a third of believed range
- **source**: `33bae36`
- **subsystem**: AI / aero seam
- **symptom**: the AI asks for hucks it physically cannot throw and they land short. A 40 m
  backhand derives to 14 m/s — 15% power — and no elevation carries that forty metres.
- **root cause**: `maxThrowRange` and the integrated flight model are independent fits.
  Both halves are faithful ports, so the reference has it too; it is the likely reason a
  huck was rare in either game.
- **how it was caught**: **G** — the new solver sweep, which pinned the shortfall so that
  fixing it becomes a visible event.
- **mutation**: in `AI/AIMath.swift`, scale `maxThrowRange`'s output by 1.4 (re-opening the
  gap between believed and achievable range).

---

## Catch resolution and the catch band

### B-11 — `predictCatchPoint` aimed at a height `tryCatch` will not award a catch at
- **source**: `.agents/friction-log/20260806171905-ai-predictcatchpoint-aimed` (major)
- **subsystem**: catch / AI
- **symptom**: "too many layouts." Over 50 sim-minutes, **80% of all bids** were for a disc
  whose predicted catch point was under 0.2 m, and the offence laid out 4.5 times a minute.
  Disabling bids entirely dropped completions 115 → 89, because the dives were load-bearing.
- **root cause**: the descending-through-1.45 m branch needs the disc to have been *above*
  1.45 m on the previous sample. Throws release at ~1.35 m and a flat forehand never rises
  past it, so the rendezvous fell through to the second branch: `s.y <= 0.12`, the point
  where the disc hits the ground. `tryCatch` refuses a standing catch below `groundY + 0.20`.
- **how it was caught**: **H** — a human noticing an absurd number of layouts on screen,
  then 50 sim-minutes of measurement. The entry is explicit that "nothing about the symptom
  points at the cause."
- **mutation**: in `swift/Sources/UltimateSim/AI/TeamAIDefence.swift:786`,
  `predictCatchPoint` — raise the descending-crossing threshold to 1.45 and drop the clamp,
  so the fallback branch returns the ground-contact sample.

### B-12 — `predictCatchPoint`'s two branches disagreed about their own floor
- **source**: `ee29260` / `e0ce282` ("The catch band is one band…" / "…is asserted")
- **subsystem**: catch
- **symptom**: the disc-peer branch reported the raw height of the first sample under the
  floor. At a 1/30 s step on a diving disc that is **0.013 m** — under the height the rules
  will pay a standing catch at at all. **251,940 of 536,030** live rendezvous over eleven
  matches were below the AI's own floor; 280 were below the *rules'* floor.
- **root cause**: the glide integrator clamped the rendezvous to `CATCH_FLOOR`; the
  disc-peer branch did not.
- **how it was caught**: **G** — by the new `catchband` golden and `CatchBandTests`, which
  were red on 27 of 75 grid cases before the fix. The synthetic grid sweeps descent rates
  past the point where one sample step crosses the whole band, which live play produces only
  occasionally.
- **mutation**: in `TeamAIDefence.predictCatchPoint`, remove the `CATCH_FLOOR` clamp from
  the `world.discPeer` branch (line ~788) while leaving the glide branch clamped.

### B-13 — the reference's catch predictor reached the disc through the *render* system
- **source**: `d1d3173` ("The receiver can chase a huck now"); named in
  `tools/goldens/matchdiff.ts:17-19`
- **subsystem**: engine wiring / catch prediction
- **symptom**: over 182 deep flights the disc landed within 1.0 m of its aim, the chaser
  *was* the intended receiver, he was sprinting — and he still finished 10 m away, because
  the point he was running at moved 0.165 m per frame. Deep throws went 3-for-25; 28 of 72
  failed throws over 25 m were throwaways with nobody within eight metres.
- **root cause**: `predictCatchPoint` reached the disc through `ctx.sys['disc']`, the
  **render** system, which does not exist in a headless match — so every headless prediction
  ran on the fallback glide integrator (gravity 3.1, flat drag), while the Swift port wired
  the disc's own integrator in (`w.discPeer = disc`, `Engine.swift:870`). The two ports were
  reasoning about different discs.
- **how it was caught**: **N** — nothing could see it: the TeamAI trace golden sets
  `sys: undefined` **on purpose**, so the fixture that owns this function was structurally
  blind. Found by investigating why the deep game did not work.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift:870`, delete
  `w.discPeer = disc` in `buildWorld()`, forcing `TeamAIDefence.predictCatchPoint` down its
  `discPeerFailed` glide fallback (`AI/TeamAIDefence.swift:823`).

### B-14 — a layout's reach was modelled three different ways in three files, none agreeing
- **source**: `.agents/friction-log/20260806171847-a-layout-s` (major); partly closed at
  `a6a1623` and `5ee4b6c` (issue #3)
- **subsystem**: catch / AI
- **symptom**: the AI authorised dives out to 2.15 m for a body that physically reaches
  1.55 m. Defensive bids touched the disc **4.7%** of the time; the rest landed on the chest
  and cost 2 s of recovery for nothing.
- **root cause**: `layoutExtend(p)` (0.85–2.15 m, agility-scaled) drove the bid gate;
  `Game.tryCatch` pays out on a **flat** `CATCH_REACH 0.82` / `LAYOUT_REACH 1.55`;
  `tools/test-ai.ts` had a third model of its own.
- **how it was caught**: **N** — found by reading all three files while diagnosing a
  different symptom. Nothing in `AI.ts` hinted that its athleticism model was advisory.
- **mutation**: in `swift/Sources/UltimateSim/AI/AIMath.swift:78-79`, unbind
  `STANDING_REACH` / `EXTENDED_REACH` from `CatchDecision.catchReach` / `.layoutReach` and
  retype them as literals `0.90` / `1.75`; and in `AITypes.swift:290` re-thread
  `layoutExtend` into the bid gate in place of the flat `EXTENDED_REACH`.

### B-14a — `LAYOUT_CEILING`: an inert reference guard, and a "fix" that would flip two opposite decisions
- **source**: `swift/Sources/SimChecks/Goldens/divergences.json` (the sole declared
  divergence); `.agents/friction-log/20260810-adr-0007-named-three-sites`
- **subsystem**: catch / AI defence
- **symptom**: the reference guards a bid at `land.y < 1.85` and **nothing reaches it** —
  over 202,438 evaluations across three reference matches, max `land.y` was 1.4498, because
  `predictCatchPoint` clamps to `CATCH_CEILING = 1.45`. So a defender leaves his feet for a
  chest-high disc he could only ever have jumped at, and spends two seconds on the turf.
  30% of otherwise-eligible bids arrive above 1.10 m.
- **root cause**: the guard was set above the clamp that feeds it. The declared Swift
  divergence is 1.10 (a prone body's real reach).
- **how it was caught**: **N** — by an audit that measured the branch, long after the fact.
  The friction entry also records the *trap*: ADR-0007 and issue #24 named three call sites,
  but two are `land.y > …` **jump** gates where the same number does the opposite job, so
  "wiring the constant to its three sites" would switch on a branch that has never executed.
- **mutation**: in `AI/AIMath.swift:160`, set `LAYOUT_CEILING = 1.85` (erasing the declared
  divergence); or, for the trap, apply 1.10 to the two `land.y > …` jump gates in
  `TeamAIDefence` and `TeamAIThrow` as well as the bid gate.

### B-15 — `bidShortfall` returned one end of the catch window and both call sites paired it with the other end's deadline
- **source**: `c491099` ("Two players arriving at the same disc is not a foul")
- **subsystem**: catch / AI bidding
- **symptom**: the laid-out D went to **0.0 a game**, which also killed the hitstop, since a
  dive is its only trigger.
- **root cause**: `bidShortfall` returns the better of the two ends of the catch window;
  both call sites paired it with `land.lastT`, the deadline of the **late** end. Harmless
  while the disc dived into the turf a metre in front of the receiver (the two deadlines
  coincided) and fatal once flights went flat: `deadline <= BID_LEAD` was false for every
  frame in which a dive could still have reached it, and by the time it was true
  `short < EXTENDED_REACH` was false instead.
- **how it was caught**: **I** — found while chasing the calls-rate explosion; the laid-out-D
  rate had a floor but the friction log records that the *old* rate was never real either
  (B-11), so a zero did not read as new.
- **mutation**: in `AI/AIMath.swift`, collapse the two shortfall questions back to one —
  have both the early gate (`reachShortfall`, kinematic) and the late gate
  (`arrivalShortfall`, ratio) read the same late deadline.

### B-16 — the catch was priced against nothing: 42% of receptions were layouts
- **source**: `bfc6385`
- **subsystem**: catch
- **symptom**: 42% of all receptions were dives; drops were 10% of passes.
- **root cause**: release scatter put a 20 m pass a full metre out — exactly the band between
  a standing catch and a dive — and a flat `+0.55` layout term charged a fingertip-past-reach
  grab the same as a full extension.
- **how it was caught**: **I** — measurement during the #17/#40 calibration.
- **mutation**: in `swift/Sources/UltimateSim/Play/CatchDecision.swift`, replace the
  reach-band-scaled layout term with a flat `+0.55`, restore the difficulty slope from 0.24
  to 0.38, and multiply release scatter back up by 1/0.6.

### B-17 — catch difficulty charged for defenders the rules will not let touch the disc
- **source**: `a77148b`
- **subsystem**: catch
- **symptom**: the median drop was a 6 m dump to a standing receiver completing 89%, where
  the sport completes 98%.
- **root cause**: a flat 0.30 charged to any defender inside 1.9 m, including bodies
  `tryCatch` excludes from the contest.
- **how it was caught**: **I** — found while unpicking B-01's downstream effects.
- **mutation**: in `CatchDecision.swift:240`, make `catchContest` count every body within
  1.9 m regardless of whether it is playing the disc (i.e. make it `contestCount`).

### B-18 — `Engine.grade` read `contestCount` where the decision used `catchContest`
- **source**: `d373d8d` ("The catch grade reads the decision instead of copying it")
- **subsystem**: catch / presentation seam
- **symptom**: the catch grade disagreed with the decision that produced it. Measured over
  four minis matches, `contest > 0` on **none** of 55 catches against the crowd question on
  40 of them.
- **root cause**: `Engine.grade` re-derived two of `CatchDecision.decide`'s own locals from
  the body array because `Result` did not carry them, and it landed on the wrong side of a
  split (`catchContest` is gated on a defender actually playing the disc; `contestCount` is
  not). The comment described the other function.
- **how it was caught**: **N** — an architecture review looking for copy drift, and the
  drift found was in the *opposite* direction to the one expected.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift:1223`, `Engine.grade` —
  recompute `laidOut`/contest off `bodies` instead of reading `CatchDecision.Result`.

---

## Rules and the calls layer

### B-19 — a replaced `Locomotion` silently dropped its `LocoHost`, making strips and receiving fouls unreachable ⚑
- **source**: `509b4ec` ("Contact reached the calls layer for the first time (#55)");
  `.agents/friction-log/20260809174439-a-locomotion-replaced` (major); named in
  `tools/goldens/matchdiff.ts:10-12`
- **subsystem**: engine wiring / rules
- **symptom**: strips fired 1–2 a game in the TS reference and **never once** in the Swift
  port across eleven matches. `policeCatch` reached its contact test 21 times over three full
  matches and found a hit **zero** times. The receiving foul and the strip were not rare in
  the port — they were unreachable, and had been since the feature landed.
- **root cause**: `Locomotion.attach(LocoHost)` stores the host **on the instance**.
  `Engine.stagePoint()` does `loco = Locomotion()` once a point (deliberately — it is how
  per-point stamina restoration works), which throws the host away. The single `attach` in
  `Engine.init` was followed on the very next line by `stagePoint()` opening the first point,
  so the contact stream was severed before one tick of one match had run.
- **how it was caught**: **MD — matchdiff, and only matchdiff.** `catchContactCall` was
  differed bit-exact and green throughout; every component fixture stayed green; a model with
  no host is a valid model, so a severed event stream is indistinguishable from a quiet one.
  The reachability-parity assertion (3 vs 0 over eleven matches) is what saw it. This bug is
  the reason `matchdiff` exists.
- **mutation**: in `swift/Sources/UltimateSim/Play/EnginePoint.swift`, `stagePoint()` —
  delete the `attachContacts()` call that follows `loco = Locomotion()` (line ~140). The
  code carries a comment there saying "forgetting this line is #55."

### B-20 — a stall-out left the disc in the thrower's hand
- **source**: `869ce7e` ("A stall-out left the disc in the thrower's hand")
- **subsystem**: rules / disc runtime
- **symptom**: the disc stayed physically held by a player who no longer had possession, and
  the invariant that the disc's hand and the machine's thrower agree failed on **every tick**
  of the dead phase — 2,758 assertions.
- **root cause**: a stall-out is the one turnover where the disc never physically leaves
  anyone. The machine took possession away; nothing told the runtime to let go.
- **how it was caught**: **P** — by an existing invariant assertion, but only once the path
  became reachable. It went unnoticed because the AI never stalls (it releases well inside a
  ten-count); the path opened only when someone tried shortening the minis count.
- **mutation**: in `swift/Sources/UltimateSim/Game/GameState.swift`, in the stall-out
  turnover path, skip the release of the held disc (leave `carrier` set on the disc runtime
  while the game hands possession over).

### B-21 — every marking foul in the game was the collision of arrival
- **source**: `c491099`; `06db499` ("Every gameplay target is met, and two bugs did all of
  it")
- **subsystem**: rules / calls
- **symptom**: calls went from 3.8 to 8.3 a match with matches stopped fifteen times. Of 48
  fouls over three matches, 43 were marking fouls and **42 of those 43 were called at stall
  count 0 with a median marking age of 0.01 seconds**. The contact that happened during a
  real, settled mark (median age 0.41 s) was the contact the detector let go.
- **root cause**: `markerStatus` turns `legal` the instant an arriving defender crosses three
  metres, and on that same tick he is still inside the man who just caught the disc, because
  the two ran to the same place. The engine anchors the thrower on the catch and gives him
  infinite mass, so the resolver pushes the defender out of him every tick — which reads as
  "a defender who has to be pushed out of the thrower", the right reading of a settled mark
  and a completely wrong reading of a receiver still running at 2 m/s.
- **how it was caught**: **I** — surfaced as a rate explosion after B-01's fix landed
  (`08cf5da` had to re-land the fix first because "you cannot fix a detector against a world
  where the event it misjudges does not happen"), then diagnosed by measuring the age
  distribution of the fouls.
- **mutation**: in `swift/Sources/UltimateSim/Rules.swift:475-488`, delete the two guards
  in `markingFoulImpact`: `if markingTime < MARK_SET_TIME { return 0 }` and the
  `MARK_SETTLED_SPEED` speed test.

### B-22 — `zoneDefence`'s cup search never excluded the thrower, producing a real double team
- **source**: `4c421c4` ("Close #39: zoneDefence's thrower-inclusion bug was a real double
  team")
- **subsystem**: AI defence / rules compliance
- **symptom**: on the sweep's one windy (zone-calling) seed, cup-left and cup-right spent the
  point being pulled toward the thrower rather than toward an attacker, landing well inside
  his ten-foot bubble without covering anyone — **USAU 16.G double team by construction, 63%
  of live-possession time** (under 1.5% on the five calm seeds). It stalled the count often
  enough to force the AI's hold-time fallback instead of a real decision.
- **root cause**: the "react to the nearest offensive body" search for non-mark cup roles
  never excluded the thrower, and cup stations are anchored to the disc, so the thrower
  usually *was* the nearest body.
- **how it was caught**: **TB** — a per-seed completion band in `tools/test-game.ts` went
  red on seed 33333 and was investigated rather than re-rolled. `Rules.doubleTeamOffender`
  already applied the exclusion one step later, when judging; nothing applied it in the
  positioning that put the body there.
- **mutation**: in `swift/Sources/UltimateSim/AI/TeamAIDefence.swift`, `zoneDefence`
  (~line 550-575) — remove the thrower exclusion from the nearest-offensive-body search for
  non-mark cup roles.

---

## AI decision layer (TeamAI, Playbook, pitch scaling)

### B-23 — every shape and value constant in the AI is a metre count measured on 100 × 37 m
- **source**: `a87b7d5` ("The minis pitch is a pitch, not a smaller number of the same
  metres"); `7fcb850`; `.agents/friction-log/20260810-every-shape-constant` (major)
- **subsystem**: AI / Playbook
- **symptom**: on the default (minis) pitch, a human-driven session alternated possession
  every ten seconds, ended **every** possession at the stall count, and was 0-0 after 150 s.
  Concretely: the vertical stack spans 27.8 m downfield against an 18.5 m end line, so all
  five stations clamped into the endzone and stood on each other; `laneOf`'s 16 m boundary
  made two of six lanes unreachable; `laneClearOfLiveTargets` discarded **1,836** candidate
  routes in one match against a target nowhere near them; `possessionValue`'s 64 and 18 put
  the whole minis pitch inside the flat top of the value curve, so a completion gaining a
  quarter of the field was worth +0.036 against a turnover costing 0.46 — a rational thrower
  holds, and 56–89% of every minis turnover was a stall-out.
- **root cause**: roughly forty bare metre literals written when there was one pitch, ported
  literally.
- **how it was caught**: **H** — a human playing the default format. Every telemetry band in
  the repository is a sevens band; `EngineTests` ran on both formats but the minis arm
  asserted nothing, printing a `Check.note` saying "minis is still a backward game." **A note
  cannot fail**, and it went on printing after it stopped being true.
- **mutation**: in `swift/Sources/UltimateSim/AI/Playbook.swift`, make `depthScale` and
  `widthScale` return a constant `1.0` (line 330). Every consumer — `formationStations`,
  `laneOf` (line 847), `buildCut`, `scoreCut`, `possessionValue`, the zone stations — reverts
  to regulation metres on every pitch, bit-identically at sevens.

### B-24 — `isDeepShot` was arithmetically unreachable at minis: 0 of 332 live releases
- **source**: `.agents/friction-log/20260810-the-deep-shot-is-unreachable-at-minis` (major);
  fixed at `7fcb850` (issue #28)
- **subsystem**: AI throw decision
- **symptom**: the whole huck valuation — the jump-ball completion model, the `pStay`
  out-of-bounds tax, the 0.24 pin credit, the halved turnover charge — was **dead code on the
  default pitch**. Measured over five minis seeds and 332 live releases: fired **0** times,
  against 33 of 576 at sevens. Read as a fraction of the pitch, the same test fires 40 times
  over three minis matches: the offence throws plenty of deep shots, they are simply never
  *valued* as deep shots.
- **root cause**: `gain >= 22 && d >= 25`, two absolute metres measured on a 32 m goal line,
  against a minis goal line at 12.5 m.
- **how it was caught**: **N** — nothing. `isDeepShot` is a local in an internal function
  and `SimChecks` could not see the decision at all; `EngineTests` asserted `hucks >= 2 *
  matches` but only at sevens, and counted a *flight* of 28 m, which is a consequence rather
  than the decision. Found by a deliberate grep for bare metre literals *in comparisons*.
  The entry's own line: "a threshold that is never crossed looks like nothing at all."
- **mutation**: in `swift/Sources/UltimateSim/AI/TeamAIThrow.swift:316`, drop the
  `* deepGate` scaling from both `DEEP_SHOT_GAIN` and `DEEP_SHOT_REACH` (they are declared at
  lines 47-48 and are 1.0-neutral at sevens).

### B-25 — `flightPath` modelled a ballistic arc, so `laneBlockage` could not see a defender in any lane
- **source**: `a77148b`
- **subsystem**: AI throw decision
- **symptom**: `blockage` was 0.008 on the mean completion and **identically 0.000 on every
  throw that was blocked or intercepted**. The AI could not see a defender in the lane of any
  throw over 26 m.
- **root cause**: `laneBlockage` discards samples above a defender's reach, and the modelled
  arc lifted the disc out of reach; the real disc flies flat (0.9–1.3 m for the whole flight
  from 6 to 30 m).
- **how it was caught**: **N** — nothing. Found by reading the model after B-01 exposed the
  general shape.
- **mutation**: in `AI/TeamAIThrow.swift:380`, `flightPath` — replace the flat-flight sample
  generator with a ballistic parabola between release and aim.

### B-26 — `separationAt` priced a pass off the defender nearest the *receiver*
- **source**: `a77148b`
- **subsystem**: AI throw decision
- **symptom**: a poach, an undercut and the deep help were invisible. The median
  interception was a disc taken 1.2 m from its receiver by a defender 0.5 m off it, on a
  throw priced at **4.1 m of separation**.
- **root cause**: only one of the two relevant defenders was considered.
- **how it was caught**: **I** — measurement of interceptions after B-01.
- **mutation**: in `AI/TeamAIThrow.swift:512`, `separationAt` — consider only the defender
  nearest the receiver, dropping the nearest-to-catch-point term.

### B-27 — `laneBlockage`'s 78% tail cutoff was blind to zone helpers
- **source**: `fed7080` (reference) / `83323ed` (Swift);
  `.agents/friction-log/20260813180828-issue-57-phase` and `…20260813171221-issue-57-phase`
  (both major); issue #57
- **subsystem**: AI throw decision
- **symptom**: windy completion sat at 67.1% against a 70% floor. Of 234 blocked throws,
  **98.3% were priced at blockage < 0.2 at selection time** — the offence was not gambling,
  it was throwing through defenders it priced as essentially not there. 96.6% of blocks came
  from zone roles.
- **root cause**: `laneBlockage` samples only up to `cut = 0.78 * tf`, on the stated
  assumption that only the receiver's own man threatens later and he is priced by
  `separationAt`. True in person defence; false in zone, where a wing/short-deep helper who
  is nobody's man closes in exactly that window. Measured: **73.6% of windy blocks landed
  past the cutoff**; for wing-open, short-deep and wing-break it was 97–100%.
- **how it was caught**: **TB** — `tools/test-ai.ts`'s "windy completion % stays sane" band,
  red for a long time and initially misattributed to the throw solver (see B-08 and
  `…20260811175247-tools-test-ai`). Attribution took a full ablation study.
- **mutation**: in `AI/TeamAIThrow.swift:444`, `laneBlockage` — delete the tail extension
  past `cut` entirely, restoring the hard `s.t > 0.78 * tf` cutoff for all defenders.

### B-28 — the tail-extension fix, ungated, collapsed the sevens deep game
- **source**: `a63454f` / `09dd60a` ("Gate laneBlockage's tail extension on the opponent
  playing zone"); `.agents/friction-log/20260813180828-issue-57-phase`
- **subsystem**: AI throw decision
- **symptom**: `the deep game exists` fell to 2 attempts against a floor of 6; `the deep-shot
  valuation fires` to 5 against 6. Calm-day completion swung as low as 72.3% from 78.9%.
- **root cause**: a huck's flight time roughly doubles past `SOLVE_LOFT_RANGE`, so `cut` is
  already several seconds on a 25 m throw, and the reach-growth term
  (`v * (s.t - 0.14) * 0.72`) extended to the true endpoint gives any defender near a crowded
  endzone a double-digit-metre "reach" — which **saturates** the `(reachable - hd) / 1.4`
  clamp rather than merely discounting. Separately, `onMan`/`onDisc` are a poor proxy for
  "the receiver's actual defender" whenever a cut has genuinely created separation.
- **how it was caught**: **TB** — the Swift `EngineTests` huck floors. A regression caught by
  the suite, recorded here because it is exactly the kind of thing a replacement spec must
  still catch.
- **mutation**: in `AI/TeamAIThrow.swift` (~line 434-441), remove the
  `world.scheme[1 - team] == .zone` gate (`foeZone`, set at line 222) on the tail extension.

### B-29 — `evaluateOptions` priced near-zero-gain throws by accuracy alone, inverting elite vs weak rosters
- **source**: `4e0c02a` ("Fix elite-vs-weak roster rating inversion (#36)");
  `.agents/friction-log/20260811191409-buildsim-with-no` (major)
- **subsystem**: AI throw decision
- **symptom**: a 90-overall roster lost to a 52-overall roster on points and turnover rate.
- **root cause**: two compounding causes. (a) accuracy inflated `pThrow`/`ev` enough that a
  re-dump cleared the `hold` bar it had no business clearing, so an accurate team racked up
  empty exchanges that cost it turnovers per possession; (b) the AB test itself paired
  rosters with mismatched formation/force/aggression configs (see T-07).
- **how it was caught**: **TB** — the `ratings change on-field outcomes` assertion in
  `tools/test-ai.ts`.
- **mutation**: in `AI/TeamAIThrow.swift` (~line 355), delete `NO_PROGRESS_TAX` and the
  `NO_GAIN_CAP` clamp on accuracy's contribution.

### B-30 — `boundaryRoom` caps TOTAL speed, so a body on the sideline is frozen in every direction
- **source**: `.agents/friction-log/20260806173727-boundaryroom-caps-total` (**blocker**);
  fixed at `0ac8542` (issue #33)
- **subsystem**: AI locomotion steering
- **symptom**: a match deadlock. A collector wedged for 103 s, 6.35 m from a stationary disc;
  one seed spent 87% of a 400 s run dead at 0-0. Turnovers routinely leave the disc on the
  chalk at |x| = 18.50; the collector runs to x = −17.95, wants a direction 99% along the
  sideline, reads zero room, and stops forever.
- **root cause**: the cap is on the **scalar** speed but the room is measured along the whole
  ray, so a player on the limit aimed at anything with a sliver of outward x gets
  `room = 0 / |ux| = 0`.
- **how it was caught**: **P** — by `tools/_deadlock.ts`, a purpose-written probe, which
  wedged 1 of 12 seeds. `tools/test-game.ts` samples one seed and had missed it for an
  unknown length of time. The entry notes the deadlock probe was not in the standard
  verification list.
- **mutation**: in `swift/Sources/UltimateSim/AI/TeamAI.swift:824`, delete the central
  `pb.clampToField(Vec2d(tx, tz), margin: boundaryRoomMargin)` clamp in `intent()`, so
  targets reach `boundaryRoom` unclamped again.

### B-31 — `Playbook`'s `FIELD_BAND` was a global, leaking a 17.6 m handler row onto a 9 m half-width
- **source**: `4b6aa87` ("Playbook ported, and a hole the mutation test found")
- **subsystem**: AI / Playbook
- **symptom**: stations off the pitch at minis.
- **root cause**: field geometry read from a module global rather than threaded, so a port
  that kept 18.5 hardcoded passes every golden.
- **how it was caught**: **P** — by a property assertion written during the port (every
  station, cut target and zone station must fit inside 9 × 18.5 m), precisely because "no
  golden can check that, since `Playbook.ts` cannot express a second pitch."
- **mutation**: in `AI/Playbook.swift`, replace `fieldBand`'s computed form with the
  regulation literal so it no longer follows `field`.

### B-32 — the pin floor's "mirror" picked the deeper of two candidates
- **source**: `bd4dbac` ("The pin floor's mirror only reached the floor it was meant to still
  enforce"); the analysis survives as a comment at `AI/Playbook.swift:562-590`
- **subsystem**: AI / Playbook
- **symptom**: turnovers per point went 0.88 → **3.17** (issue #35). The backfield stood up
  to 6.5 m into its own endzone after a deep pull.
- **root cause**: `Math.min(floorZ, mirrored)` for `dir > 0` took the deeper of the two where
  the contract needed the shallower. Whenever the mirror actually cleared the floor it was
  inert; it was live only in the one regime `PIN_MARGIN` exists to rule out.
- **how it was caught**: **TB** — a turnovers-per-point band in `tools/test-game.ts`, then
  empirical bisection across two commits in detached worktrees.
- **mutation**: in `AI/Playbook.swift` (~line 558-590, `formationStations`' floored-handler
  branch), reinstate the mirror as `min(floorZ, mirrored)` for `dir > 0`.

### B-33 — `smoothstep`'s NaN guard was unobservable
- **source**: `4b6aa87`
- **subsystem**: AI / Playbook (numerics)
- **symptom**: none shipped — a NaN upper edge would propagate into a cut target. This is a
  *coverage* defect recorded because it is the shape a spec must catch.
- **root cause**: JavaScript's `||` falls through on NaN, so a NaN upper edge takes the
  `1e-6` branch and returns exactly 1; without the guard it returns NaN. The golden sampled
  `+0` and `−0` and never NaN, so deleting the guard changed nothing at all.
- **how it was caught**: **MT** — mutation testing during the port. "The port was correct and
  its comment was true. Nothing was checking it."
- **mutation**: in `AI/Playbook.swift`, delete the NaN arm of `smoothstep`'s falsy guard.

### B-34 — `AIWorld` is a value type, so the TS reference's shared-object write silently did nothing
- **source**: `.agents/friction-log/20260813162109-aiworld-is-a` (major); `d91fc8d` (issue #57)
- **subsystem**: AI wiring / port fidelity
- **symptom**: **44 failed assertions** in the `teamai` differential — `chooseFormation`
  returning `.vertical` where the golden said `.horizontal`, at exactly the frames where a
  team had just called zone. The offence never learned the defence's scheme.
- **root cause**: the TS side worked by having `pickScheme` write into `world.scheme[team]`,
  a single mutable object shared by reference across both teams' `update()` calls. Swift's
  `AIWorld` is a `struct` passed by value, so the identical-looking line updated a local copy
  and was discarded on return. No compiler warning, no runtime error.
- **how it was caught**: **G** — the `teamai` component golden. Note this is one of the few
  cases where a component fixture *did* catch a port bug, which is exactly why it matters
  that the replacement keeps that resolution.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift:839`, `buildWorld()` — stop
  populating `w.scheme` from `[ai[0].currentScheme, ai[1].currentScheme]` and leave it at its
  default, so `foeZone` (`TeamAIThrow.swift:222`) is always false.

---

## Locomotion

### B-35 — the roster's attribute draws happened in the wrong order in Swift
- **source**: `14fb5ac` ("The AI's pure functions, and an ordering bug I wrote and the
  fixture caught")
- **subsystem**: locomotion / roster generation
- **symptom**: "a completely plausible and completely different player from the same seed."
- **root cause**: `makeAttributes` consumes a seeded RNG and the reference builds one object
  literal that JavaScript evaluates top to bottom; Swift evaluates initialiser arguments in
  *call* order, which differs because `throwAccuracy` sits before `throwPower` in the
  signature.
- **how it was caught**: **G / MT** — by the golden as it was being written, and confirmed by
  re-introducing the mutation: **297 assertions** fail.
- **mutation**: in `swift/Sources/UltimateSim/Move/Attributes.swift` (and the AI attribute
  builder), fold the separate per-draw statements back into a single initialiser call, so
  argument order drives the RNG stream.

### B-36 — `FootState` is a value type held by a class, so `var f = p.foot` mutates a copy
- **source**: `113fe54` ("Locomotion ported, and a comment that was lying")
- **subsystem**: locomotion / port fidelity
- **symptom**: the write compiles, looks correct, and silently does nothing.
- **root cause**: Swift value semantics on a struct field of a reference type. The port
  documents this hazard at seven separate sites.
- **how it was caught**: **G / MT** — the locomotion trace golden (87,643 assertions over
  1,095 steps), mutation-tested: scaling gravity by 1.001 fails 307 assertions.
- **mutation**: in `swift/Sources/UltimateSim/Move/Locomotion.swift`, rewrite one of the
  `p.foot.pos.x += …` sites as `var f = p.foot; f.pos.x += …` and drop the write-back.

### B-37 — `resolveContacts` split its correction by inverse mass, so the marker shoved the thrower off his pivot
- **source**: `.agents/friction-log/20260806102822-a-thrower-still` (minor, but the
  underlying defect is a rules violation); the fix survives at
  `Move/LocomotionContacts.swift:184`
- **subsystem**: locomotion / rules
- **symptom**: a limit cycle: the inward pull to the pivot converged monotonically, hard
  contact bumped the thrower back out to ~2 m, and it started again. Settled drift 5.47 m,
  then 2.32 m, against a `PIVOT_R` of 0.75 m — a travel violation the sport takes seriously.
- **root cause**: `Locomotion.resolveContacts` divides positional correction between two
  bodies by `invMass`, so a marker standing on the thrower pushed him a few centimetres per
  contact. The entry records that the soft-separation tier and the stick were both ablated
  first and were byte-identically innocent.
- **how it was caught**: **P** — `tools/test-game.ts`'s settled-drift assertion, but only as
  a *number*; the mechanism took three ablations to find.
- **mutation**: in `Move/LocomotionContacts.swift:184`, make `invMass` return a finite value
  for an anchored body instead of `0`.

### B-38 — `anchored` was ported and never once set
- **source**: `a5dfc87` ("The thrower keeps his pivot, and a disc on the chalk gets
  collected")
- **subsystem**: locomotion / rules
- **symptom**: possession advancing without a throw — "the one thing the sport forbids." A
  crowding marker walked the thrower off his own pivot every time he pressed in.
- **root cause**: the flag existed, `Separation` and the contact resolver honoured it, and no
  caller ever wrote it.
- **how it was caught**: **N** — found by an audit of "things the reference does that this
  file did not." Nothing detected an always-false flag.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift` / `EnginePoint.swift`, stop
  setting `LocoPlayer.anchored` for the carrier (`Move/Types.swift:246`), so
  `Separation.swift:159` and `LocomotionContacts.swift:185` never fire.

### B-39 — `stepPivot` deleted the pivot the moment `anchored` went false, refilling the grace budget at every check
- **source**: `.agents/friction-log/20260810-pivot-deleted-at-check` (minor)
- **subsystem**: locomotion / rules
- **symptom**: worst settled thrower drift **6.95 m**, entirely in the frames after checks.
- **root cause**: `if (!p.anchored) { this.pivots.delete(p.id); return; }` throws away the
  grace budget (the metres of run allowed while arresting), so the next anchored frame calls
  `openGrace` again and gets a fresh one. The game layer set `anchored` only during
  `LIVE_POSSESSION`, and a `CHECK` is not that phase.
- **how it was caught**: **P**, barely — `tools/test-game.ts`'s drift assertions caught it
  *only because* wiring timeouts made checks common enough to matter. Checks were 1% of match
  time, so the refilled budget was inside the noise of percentile assertions over twenty
  thousand frames.
- **mutation**: in `Move/Locomotion.swift:541`, restore `pivots.delete(p.id)` in the
  `!p.anchored` branch of `stepPivot`; and/or narrow the play-layer anchor condition back to
  live possession only, dropping `TIMEOUT` and `CHECK`.

### B-40 — the dead-disc pickup had a single fixed radius, so the collector parked short of a disc on the chalk
- **source**: `a5dfc87`; the reference's own note records one seed sitting in `TURNOVER_DEAD`
  for **152 seconds**
- **subsystem**: locomotion / engine
- **symptom**: the game stops. Related to but distinct from B-30: this is the pickup radius,
  that is the steering cap.
- **root cause**: `DISC_GRAB_R` forever, while the AI's perimeter speed cap parks the
  collector a metre short of a disc on the sideline. The reference escalates 1.6 → 3.6 m
  after 1.4 s. The pickup also did not skip bodies locomotion reports unavailable, so a
  player mid-layout could be the designated collector.
- **how it was caught**: **P** — the deadlock probe again (`tools/_deadlock.ts`), plus goal
  rates: sevens 7 → 10 goals per 15 min, minis 10 → 13.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift`, fix the pickup radius at
  `DISC_GRAB_R` (removing the dwell escalation to `PICKUP_DWELL_RADIUS`), and drop the
  availability filter on candidate collectors.

---

## Engine wiring, disc runtime, construction

### B-41 — `Engine.autoPull` was not a port of `Game.doPull`; it aimed 16.8 m short ⚑
- **source**: `.agents/friction-log/20260811065754-the-port-s` (major); fixed at `b2868fb`;
  the ported version is `regulationPull` in `Play/EnginePoint.swift:372`
- **subsystem**: engine wiring / rules
- **symptom**: an 8–11× engine gap on `turnover:pull-drop` — the reference muffs 15–23 pulls
  over eleven matches, the port 2. The receiving team puts a hand on **158 of 170** reference
  pulls (93%); the port aimed every pull at 19.2 m where the reference aims at
  `PULL_TARGET_Z = 36`, so the disc landed 12.8 m in front of a receiving line standing on
  its own goal line, nobody was within `catchReach`, and no turnover was ever recorded.
- **root cause**: an independently invented pull. Puller selection, release height, target,
  throw model and sideways fade all differed. **None** of `PULL_SPEED`, `PULL_CARRY`,
  `PULL_DRIFT`, `PULL_TARGET_Z`, `PULL_BANK`, `PULL_NOSE`, `PULL_SPIN` existed anywhere in
  `swift/Sources/`.
- **how it was caught**: **MD** — matchdiff's `turnover:pull-drop` rate band, and it very
  nearly missed: the standing gap sat under the *absolute* floor with 0.08 events/match of
  headroom for several commits, and the run's summary note printed only the worst *relative*
  gap, which pull-drop never was. `EngineSeamTests` checks the pull against properties (that
  a pull happens, that it flies, that OOB offers the choice, that carry scales with the
  pitch) and says in its own header that it cannot see "aimed 16.8 m short of the oracle."
  ADR-0007's constant scrape covers `src/sim/AI.ts` **only**, so the pull constants living in
  `Game.ts` were never subject to the "declare it or fail" rule.
- **mutation**: in `Play/EnginePoint.swift`, `autoPull()` (line 346) — route the
  `.standard` field through `solvedPull(p)` instead of `regulationPull(p)`, restoring the
  generic backhand-plus-bisection pull.

### B-42 — `Engine.stagePoint`'s opening formation was not `lineUpForPull`
- **source**: `.agents/friction-log/20260813144820-engine-stagepoint-s` (minor, issue #56);
  fixed at `52d9b79`
- **subsystem**: engine wiring
- **symptom**: at the zero-tick instant the two engines' rosters stand in different places.
  Seed 11's puller: reference `(-5.0, 31.5)`, port `(-3.7, 30.4)`.
- **root cause**: `stagePoint` used a generic opening shape
  (`lateral = (slot/span - 0.5) * width * 0.6`, `z = -dir * goalLine * 0.95`) instead of
  `lineUpForPull`'s formula.
- **how it was caught**: **G** — discovered while building the `pull.json` golden (issue
  #48), which had to sidestep it by placing the puller explicitly. The entry is honest that
  `pull.json` therefore does **not** verify that a real ticked match ever puts the puller
  where the reference would.
- **mutation**: in `Play/EnginePoint.swift`, `stagePoint()` (line 116) — replace the
  `lineUpForPull` formula with `lateral = (slot/span - 0.5) * width * 0.6`,
  `z = -dir * goalLine * 0.95`.

### B-43 — the port's engine seed, weather and roster forks did not match the reference's
- **source**: `d70cc22` ("Align the port's engine seed, weather and roster forks with the
  reference"); the residual is documented in `tools/goldens/matchdiff.ts:35-45`
- **subsystem**: engine construction
- **symptom**: a given seed produced a **completely different roster** in each engine, and
  every draw after roster-dealing diverged with it. Seed 11 is a 3-9 game in the reference
  and an 8-9 game in the port, with fourteen different athletes on the field. This is why
  matchdiff can only compare distributions.
- **root cause**: `Game.ts`'s `ctx.rand` is a top-level stream with three independent forks
  (`0x6a3e1c` engine, `0x117d` weather, `0x0a11ce` roster) at team overalls `[76, 74]`;
  `Engine.swift` seeded `self.rng` directly and dealt the roster from that same stream at
  72/72 in a different archetype order. A residual gap remained even after the fork fix:
  `Game.ts`'s roster loop draws three extra `gauss()` calls per player for height/mass/
  strength which the port computes deterministically and never drew, desyncing every player
  after the first.
- **how it was caught**: **TB / I** — surfaced by issue #2's matchdiff work; nothing asserted
  roster equality, so it was found by probing the reference's roster generator directly.
- **mutation**: in `swift/Sources/UltimateSim/Play/Engine.swift`, seed `rng` directly from
  the caller's seed and remove the `topRng` three-fork structure, or delete the three burned
  `gauss()` draws in `buildRoster`.

### B-44 — the reference kept a second copy of the RNG generator
- **source**: `6bc269e` ("Give the reference one Rng and assert its seam")
- **subsystem**: engine construction / architecture
- **symptom**: no behaviour change (the fixture regenerates byte-identically) — but a second
  definition of the stream every golden depends on, and `Game.ts`/`Locomotion.ts` importing
  the *engine's* `Rng` anyway, which pulls in three.js and the post-processing composer.
- **root cause**: `SeededRng` documented itself as existing "only so the sim can run headless"
  and then was bypassed.
- **how it was caught**: **N** — ADR-0008's dependency direction was prose, "and prose does
  not fail." Found by reading. `tools/test-imports.ts` now asserts it and was red on both
  `Ctx.ts` imports when written.
- **mutation**: not a behavioural mutation. The equivalent check in Swift is the module
  dependency direction (ADR-0002/0008): add an `import FlightUI` to any `UltimateSim` file.

### B-45 — the human defensive commit deleted the speed caps its own comment promised to keep
- **source**: `b27b85b` ("The committed defender keeps the perimeter, and stops a stride
  short (#46)")
- **subsystem**: engine wiring / human input
- **symptom**: a tap to bid on a disc drifting toward the sideline sent the one body the
  player is watching at full speed with the soft perimeter gone for the whole 1.6 s, stopped
  only by the hard `keepOnField` backstop. Paired with defect (2) below, a `.close` drove a
  full-speed body into the thrower's pivot and held it there for 1.6 s — a marking foul
  against the body the player is watching.
- **root cause**: `applyDefensiveCommit` set `desiredSpeed = maxSpeed`, discarding
  `min(maxSpeed * effort, capTo, capVel, arriveCap)`. Separately, `holdPoint()` returned the
  thrower's **exact** position while its own comment said "the thrower, less a stride."
- **how it was caught**: **N** — an independent review of shipped `main`. Both defects were
  denied by the code's own comments, which is what made them invisible to reading.
- **mutation**: in `swift/Sources/UltimateSim/Play/EngineHuman.swift`, in
  `applyDefensiveCommit` set `desiredSpeed = maxSpeed` unconditionally; and have
  `holdPoint()` return the thrower's position rather than backing off 1 m along
  thrower→defender.

### B-46 — the huck's pin credit double-counted once the chase was fixed
- **source**: `d1d3173`
- **subsystem**: AI throw decision
- **symptom**: with `0.30 * pin`, completion falls to 84.4% — outside the sport's band — for
  a deep game 0.24 delivers anyway. The AI pulled the trigger on shots it priced at 11%.
- **root cause**: the term was sized when a deep shot never completed, so it was carrying the
  whole deep game on the value of the *miss*. Once B-13 was fixed and the same throws
  completed for real, the credit bought bad hucks on top of good ones.
- **how it was caught**: **I** — measurement immediately after the B-13 fix.
- **mutation**: in `AI/TeamAIThrow.swift`, restore the deep-shot pin credit from 0.24 to
  0.30.

---

## Goldens and divergence tooling

These are defects in the checking apparatus itself. They matter for #58 because they describe
the failure modes a replacement spec inherits.

### B-47 — `matchdiff.json` goes stale silently, and staleness is indistinguishable from a real divergence
- **source**: `.agents/friction-log/20260811-matchdiff-golden-is-stale` (major) and
  `.agents/friction-log/20260812154558-matchdiff-json-was` (major)
- **symptom**: the fixture described a reference that no longer existed, across two behaviour
  changes (`4e0c02a`, `6bc269e`). Regenerating moved **13 of 21 counts** — `attempts`
  1672 → 1410, `contest` 4 → 13, `foul` 21 → 34. `SimTests` passed on both, "hiding behind
  bands wide enough to hold both." The next agent to regenerate inherited somebody else's
  behaviour change as a red reachability-parity failure reading as a serious finding about
  their own work.
- **root cause**: the fixture is only ever compared against the *port*, never re-derived, and
  it costs four minutes to regenerate. "A golden that is expensive to regenerate and forgiving
  when stale will go stale, and its cost lands on the next person."
- **how it was caught**: **N** — by an agent regenerating it for an unrelated reason. Only
  the `rng` family had a freshness gate. Now partially addressed by
  `check-goldens.ts freshness` on a canonical macos-15 arm64 job.
- **mutation**: revert `src/sim` behaviour by one commit without regenerating `matchdiff.json`
  and see whether anything reports it.

### B-48 — a golden regenerated at the very commit that wrote it does not reproduce on another machine
- **source**: `.agents/friction-log/20260811070423-a-golden-regenerated` (major)
- **symptom**: `coeffs.json` differs in 4 of 2297 numbers, worst relative error 3.4e-16 — one
  or two ULP, a V8 math difference. `matchdiff.json`: **every count in the file differs**,
  because eleven fifteen-minute matches are 108,000 chaotic ticks apiece.
  `pull-drop` 23 → 15, `attempts` 1630 → 1599, `points` 176 → 170. A red band goes **green**
  purely by regenerating on a different libm.
- **root cause**: a chaotic fixture amplifies 1 ULP into 35% of its counts, and nothing
  recorded the platform the fixture was generated on.
- **how it was caught**: **N** — by an agent trying to attribute an unrelated red band, at a
  cost of ~90 minutes including two pool regenerations and a detached worktree.
- **mutation**: regenerate any libm-sensitive family on a non-canonical platform and commit
  it.

### B-49 — adding `export` to a reference constant deleted it from the divergence registry, and the failure named the wrong cause
- **source**: `.agents/friction-log/20260811-a-named-constant-is-invisible` (major)
- **symptom**: `DivergenceTests` reported "`CATCH_FLOOR` is bound in `mirrored` but the
  reference no longer declares it — drop the binding or declare the divergence." The
  reference declared it, on the same line, with the same value. **The message actively
  recommended the wrong repair**: dropping the binding would have removed the constant from
  the registry permanently, which is the exact outcome the registry exists to prevent, and it
  would have looked like a clean fix.
- **root cause**: the scrape regex was `/^const ([A-Z][A-Z_0-9]*) = …/gm`, so
  `export const CATCH_FLOOR = 0.85;` did not match. Six constants left `referenceConstants`
  silently when issue #4 needed them importable.
- **how it was caught**: **P**, but misleadingly — `DivergenceTests` fired and pointed at the
  wrong file. "The suite designed to catch a silent divergence produced a message pointing at
  the reference, when the reference had not moved."
- **mutation**: not portable to Swift — this is the shape of failure a source-scraping check
  has. Its Swift analogue: any check that identifies a symbol by matching source *syntax*
  rather than by resolving it.

### B-50 — ADR-0007's constant scrape covered `src/sim/AI.ts` only
- **source**: `.agents/friction-log/20260811065754-the-port-s`, "Why nothing caught it"
- **symptom**: the pull constants live in `src/sim/Game.ts`, so the rule "a reference constant
  the port does not carry under that name has to be classified in `unmirrored` with a reason"
  **never applied to them** — which is how B-41 stayed undetected. Confirmed against the
  current `divergences.json`: `referenceConstants` holds 18 `AI.ts` names plus a separate
  `referencePullConstants` block added afterward.
- **how it was caught**: **N** — as a by-product of diagnosing B-41.
- **mutation**: narrow the divergence scrape's file list back to `AI.ts` and delete
  `referencePullConstants` from `divergences.json`.

---

## App / frame layer (outside the sim, recorded for completeness)

### B-51 — four player-facing defects lived in the clock between the frames
- **source**: `ec9b9c7` ("The clock between the frames is a thing now, and four bugs lived in
  it")
- **subsystem**: frame clock / view layer
- **symptom**: (a) a stale drag left the aim line and power bar pinned on screen and made
  **every subsequent throw grade `.overcharged` for the rest of the match** — measured 5 s of
  phantom hold and all six throw types overcharged; (b) opening the settings sheet mid-match
  corrupted the save, so a 3v3 tape resumed as a 7v7 engine and was thrown away — and with
  only the length changed, the checksum *passed* and the player was silently resumed into a
  game they never started; (c) backgrounding during a restore deleted the save being
  restored (a notification banner was enough); (d) the tick loop ran 120 `Engine.step` calls
  a second behind the result card.
- **root cause**: arithmetic in `MatchView` that nothing could reach. "The sim is a pure
  function of (format, seed, inputs) and 2.2M assertions say so, but the code that decides
  how much wall time the sim is asked to spend had no checks at all."
- **how it was caught**: **H / N** — an independent review of shipped `main`. This is the
  clearest statement in the repo of where the checks ended.
- **mutation**: in `swift/Sources/UltimateSim/FrameClock.swift` / the gesture path, have one
  of the two guards return without calling `cancelDrag()`; or drop the `isOver` term from
  the tick-loop `running` condition.

### B-52 — practice mode drew a second `RealityView` under the first
- **source**: `8dcff2a` ("Fix practice mode's double RealityView…", issue #55);
  `.agents/friction-log/20260813210619-a-second-simultaneous`
- **subsystem**: view layer
- **symptom**: the practice pitch's meshes loaded correctly and nothing ever composited —
  RealityKit refuses to blend IBL lighting across two simultaneous scenes.
- **root cause**: `MatchView` drew `PracticeView` as an overlay inside its own `ZStack`,
  leaving the match's `RealityView` mounted underneath.
- **how it was caught**: **H** — on screen. Now covered by `PracticeModeTests`.
- **mutation**: in `MatchView`, return `PracticeView` inside the existing `ZStack` rather
  than swapping the whole tree in a `Group { if … else … }`.

---

## Test-and-harness defects (not mutation targets)

Real, costly, and worth knowing about — but they live in checks, not in production Swift, so
they cannot be re-introduced as mutations. Listed for completeness of the historical record.

| id | defect | source |
|---|---|---|
| T-01 | Per-seed bands on tail statistics (longest completion, hucks attempted, hold share) resample with any unrelated change; five configurations touching no throwing code produced five different answers. "Only tighter in the sense that a coin is tighter than a die." | `…/20260809222131-enginetests-deep-game` (major) |
| T-02 | The same pattern recurred in five more suites ten hours later — six assertions re-stated, none in code the change touched. | `…/20260810-per-seed-bands-again` |
| T-03 | A coverage band on a **score-bounded** match: improving the offence shortened the match and turned the band red. "A band over how much happened is only a coverage floor if the sample is bounded by TIME." | `…/20260810-a-band-on-a-match-bounded-by-score` |
| T-04 | Three suites each replayed the same eleven canonical matches, 43 match-plays for eleven matches' worth of simulation — 537 of the suite's 724 seconds. Nothing in the code said the seed lists were the same. | `…/20260810-three-suites-played` (major) |
| T-05 | `EventTests.play()` counted a pull "resolved" on only three of four valid outcomes, so ordinary pull drops read as pulls stuck in flight. | `…/20260811191302-ai-ts-ev` (major) |
| T-06 | `HumanCutTests` scored "had further to run" as "never went", so its arrival count was a bound on how far the probe happened to point (routes ranged 3.3–28.7 m against a fixed four-second window). | `…/20260811-a-four-second-window` |
| T-07 | `buildSim(seed, wind)` with no config argument pairs formation/force/aggression with team index, confounding every rating AB test. Equal-rated rosters under the default pairing score 4-20 — a bigger spread than the 90-vs-52 rating gap the test claimed to isolate. | `…/20260811191409-buildsim-with-no` (major) |
| T-08 | `findLayoutTurnover` discovered its tick with a bare `Engine.step` loop that has no `FrameClock`, so it found ticks where the event drains but no *hitstop* starts. Invisible until a formation fix moved which seed the sweep landed on. | `…/20260813153136-findlayoutturnover-discovery-didn` |
| T-09 | A steady loop computing timestamps as `Double(i) * tickDt` drifts by a whole tick over thousands of frames; one frame in 7446 buys zero ticks. | `…/20260813090450-a-for-loop` |

Also worth noting as a *negative* result: `.agents/friction-log/20260811093827-a-sweep-for`
records a deliberate repo-wide hunt for tautological/no-op assertions that found **none** —
all nine `Check.ok(true, …)` sites are legitimate. That is evidence the suite's *quality*
problem is coverage, not padding.

---

## Source notes and honest gaps

- **`INDEX.md` is stale in both directions.** It lists 80 of the 97 entries and none of the
  17 later ones (`20260811-a-named-constant-is-invisible`, all nine `20260813*` entries,
  etc.). It also lists three entries whose directories no longer exist — `20260810-teamai-lines-up`,
  `20260811-matchdiff-golden-is-stale` (present), `20260811183614-simtests-25-failure` — of
  which `20260810-teamai-lines-up` ("TeamAI lines every body up on the goal line for any phase
  that is not live, so a mid-point stoppage cannot be expressed", major) and
  `20260811183614-simtests-25-failure` ("SimTests' 25-failure print cap silently hides a
  targeted assertion behind unrelated golden mismatches", major) have been resolved and
  deleted per the README's policy. Their titles are recorded here so the corpus does not lose
  them, but I could not read their bodies and have not given them entries.
- **Roughly 55 of the 97 friction entries are about face/skin/hair/shader rendering and
  capture tooling** (`20260805*`–`20260806025952`) and contain no sim bugs. They were scanned
  and excluded deliberately, not overlooked.
- **`divergences.json` did not contain what one might expect.** It is not a list of
  divergences; it holds exactly **one** declared divergence (`LAYOUT_CEILING`) plus two
  scraped constant tables. ADR-0007's value is the *default* (undeclared divergence = failure),
  not the registry's contents.
- **The commit count is 316, not ~330.**
- Several bugs were fixed, reverted, and re-landed (`a77148b` → `0e5bbef` revert → `08cf5da`
  re-land; `bf59ca1` → `8122b58` revert). The revert is not a separate bug; it is recorded in
  B-01 and B-21 because the sequencing — you cannot fix a detector against a world where the
  event it misjudges does not happen — is itself a finding.
